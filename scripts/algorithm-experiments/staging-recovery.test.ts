// @vitest-environment node
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordExperimentStaging, recoverExperimentStaging } from './staging-recovery'
const docker = vi.hoisted(() => ({ mode: 'absent', calls: 0 }))
vi.mock('node:child_process', () => ({ execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  docker.calls++
  callback(docker.mode === 'absent' ? new Error('No such container: test') : docker.mode === 'offline' ? new Error('Docker unavailable') : null, '[]', '')
} }))
let base: string
const deadPid = 2147483647
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'staging-recovery-test-'))
  docker.mode = 'absent'
  docker.calls = 0
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === deadPid) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(base, { recursive: true, force: true })
})
async function fixture(changes: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(base, 'sleepypod-package-'))
  await recordExperimentStaging(root, 'sleepypod-experiment-12345678-1234-1234-1234-123456789abc', 1000, 1000)
  const path = join(root, '.sleepypod-staging.json')
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...receipt, controllerPid: deadPid, ...changes }))
  await writeFile(join(root, 'input.jsonl'), 'private input', { mode: 0o600 })
  return root
}
it('removes only an expired, owned staging directory after its controller and container disappear', async () => {
  const root = await fixture()
  expect((await recoverExperimentStaging(121999, base)).removed).toEqual([])
  expect(docker.calls).toBe(0)
  expect((await recoverExperimentStaging(122000, base)).removed).toHaveLength(1)
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await recoverExperimentStaging(122000, base)).removed).toEqual([])
})
it.each([{ controllerPid: process.pid }, { inode: 1 }, { owner: 999999 }, { schema: 'unknown' }])('preserves unproven ownership or a live controller: %j', async (changes) => {
  const root = await fixture(changes)
  expect((await recoverExperimentStaging(122000, base)).removed).toEqual([])
  expect((await stat(root)).isDirectory()).toBe(true)
  expect(docker.calls).toBe(0)
})
it('retains files when Docker still has the container or is unavailable', async () => {
  const root = await fixture()
  docker.mode = 'present'
  expect((await recoverExperimentStaging(122000, base)).removed).toEqual([])
  docker.mode = 'offline'
  await expect(recoverExperimentStaging(122000, base)).rejects.toThrow('Docker unavailable')
  expect((await stat(root)).isDirectory()).toBe(true)
})
it('does not follow symlinked ownership markers or infer legacy directory ownership', async () => {
  const root = await fixture()
  await rm(join(root, '.sleepypod-staging.json'))
  const legacy = await mkdtemp(join(base, 'sleepypod-package-'))
  await symlink('/etc/passwd', join(root, '.sleepypod-staging.json'))
  expect((await recoverExperimentStaging(122000, base)).removed).toEqual([])
  expect((await stat(legacy)).isDirectory()).toBe(true)
  expect(docker.calls).toBe(0)
})
