import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Never accept caller database paths: each invocation owns fresh fixture databases.
const root = mkdtempSync(join(tmpdir(), 'sleepypod-browser-'))
const env = {
  ...process.env,
  CI: '1',
  NEXT_PUBLIC_DEMO: '',
  DATABASE_URL: join(root, 'configuration.db'),
  BIOMETRICS_DATABASE_URL: join(root, 'biometrics.db'),
  SLEEPYPOD_BROWSER_FIXTURE: root,
}
try {
  for (const args of [
    ['exec', 'tsx', 'src/db/migrate.ts'],
    ['exec', 'tsx', 'tests/browser/fixture.ts', 'seed'],
    ['exec', 'playwright', 'test', '--config=tests/browser/playwright.config.ts', ...process.argv.slice(2)],
  ]) {
    const result = spawnSync('pnpm', args, { env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1
      break
    }
  }
}
finally { rmSync(root, { recursive: true, force: true }) }
