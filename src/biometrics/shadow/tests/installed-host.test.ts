// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadInstalledShadowHost } from '../installed-host'
const directories: string[] = []
const fixture = `module.exports = { shadowHostApiVersion: 'shadow-host-api-v1', runProfiledShadowAttempt() {}, openProfiledShadowHost() {}, prepareShadowPlan() {}, ShadowStore() {},
shadowEngineBuildIdentity() {}, readInstalledShadowQualifications() {}, shadowPlanSchema: {}, shadowStoragePolicySchema: {} };`
function file(contents = fixture) {
  const directory = mkdtempSync(join(tmpdir(), 'installed-shadow-'))
  directories.push(directory)
  const path = join(directory, 'shadow-host.cjs')
  writeFileSync(path, contents)
  return path
}
afterEach(() => {
  delete (globalThis as typeof globalThis & { __sleepypodInstalledShadowHostV1?: unknown }).__sleepypodInstalledShadowHostV1
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})
it.each(['symlink', 'oversize', 'directory', 'missing'])('rejects a %s artifact before executing it', (mode) => {
  const path = file()
  if (mode === 'oversize') writeFileSync(path, 'x'.repeat(16 * 1024 * 1024 + 1))
  if (mode === 'symlink') {
    renameSync(path, path + '.target')
    symlinkSync(path + '.target', path)
  }
  if (mode === 'missing') rmSync(path)
  expect(() => loadInstalledShadowHost(mode === 'directory' ? directories[0] : path)).toThrow()
})
it('refuses preloaded Node cache entries with no verified loading history', () => {
  const path = file()
  createRequire(import.meta.url)(path)
  expect(() => loadInstalledShadowHost(path)).toThrow(/without installed identity/)
})
it('refuses incomplete or unsupported API exports', () => {
  const path = file('module.exports = { shadowHostApiVersion: \'other\' };')
  expect(() => loadInstalledShadowHost(path)).toThrow(/API/)
})
it('rejects replacement with identical bytes and a second installation path', () => {
  const path = file(), loaded = loadInstalledShadowHost(path)
  loaded.assertCurrent()
  expect(() => loadInstalledShadowHost(file())).toThrow(/restart/)
  renameSync(path, path + '.old')
  writeFileSync(path, fixture)
  expect(() => loaded.assertCurrent()).toThrow(/restart/)
})
