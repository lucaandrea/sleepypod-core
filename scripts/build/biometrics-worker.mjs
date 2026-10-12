import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const output = process.argv[2] ?? '.next/standalone/biometrics-worker'
await mkdir(output, { recursive: true })
const result = await build({
  entryPoints: ['src/biometrics/backtest/worker-entry.ts'],
  outfile: `${output}/worker.cjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  metafile: true,
  treeShaking: true,
})
// Fail packaging if the pure worker ever pulls in live application entrypoints.
const forbidden = Object.keys(result.metafile.inputs).filter(path =>
  /src\/(hardware|automation|scheduler|homekit|streaming)\//.test(path)
  || /src\/db\//.test(path) || /drizzle-orm|better-sqlite3/.test(path),
)
if (forbidden.length) throw new Error(`Replay worker has live dependencies: ${forbidden.join(', ')}`)
await writeFile(`${output}/dependencies.json`, JSON.stringify(Object.keys(result.metafile.inputs).sort(), null, 2))
