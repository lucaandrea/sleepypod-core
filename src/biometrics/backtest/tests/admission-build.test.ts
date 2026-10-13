// @vitest-environment node
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

it('retains Linux health collection when a bundler substitutes a macOS build platform', async () => {
  const compiled = await build({ entryPoints: ['src/biometrics/backtest/admission.ts'], bundle: true,
    platform: 'node', format: 'cjs', write: false, minify: true,
    define: { 'process.platform': JSON.stringify('darwin') } })
  const nativeRequire = createRequire(import.meta.url)
  const exported: { exports: { collectAdmissionSample?: (path: string, piezo: () => number) => Promise<unknown> } } = { exports: {} }
  const accesses: string[] = []
  const at = Date.now()
  runInNewContext(compiled.outputFiles[0].text, { module: exported, exports: exported.exports,
    process, setTimeout, clearTimeout, Buffer,
    require: (name: string) => {
      if (name === 'node:os') return { platform: () => 'darwin', availableParallelism: () => 4, loadavg: () => [1, 1, 1] }
      if (name === 'node:fs/promises') return {
        readFile: async (path: string) => {
          accesses.push(path)
          return path === '/proc/meminfo' ? 'MemAvailable: 1024 kB\n' : '35000\n'
        },
        statfs: async () => ({ bavail: 100, bsize: 4096 }),
      }
      return nativeRequire(name)
    } })
  expect(await exported.exports.collectAdmissionSample?.('/fixture', () => at)).toMatchObject({
    availableMemoryBytes: 1048576, freeDiskBytes: 409600, temperatureC: 35, loadPerCpu: 0.25, piezoReceivedAtMs: at,
  })
  expect(accesses).toEqual(expect.arrayContaining(['/proc/meminfo', '/sys/class/thermal/thermal_zone0/temp']))
})
