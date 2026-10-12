import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const result = await build({ entryPoints: ['src/demo/biometrics/worker.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true })
const forbidden = Object.keys(result.metafile.inputs).filter(path => /src\/(hardware|db|automation|scheduler|homekit|streaming)\/|better-sqlite3|drizzle-orm/.test(path))
if (forbidden.length) throw new Error(`Demo worker has live dependencies: ${forbidden.join(', ')}`)
const buildHash = createHash('sha256').update(result.outputFiles[0].contents).digest('hex')
await writeFile('src/demo/biometrics/worker-build.json', JSON.stringify({ buildHash, identity: 'esbuild-browser-evaluator-bundle', simulated: true }, null, 2) + '\n')
