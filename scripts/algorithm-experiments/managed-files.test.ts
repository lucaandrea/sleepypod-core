// @vitest-environment node
import Database from 'better-sqlite3'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { packageFixture } from '../../src/biometrics/packages/tests/fixture'
import { fixtureResourceTestPolicy } from './resource-test-policy'
import { managedDescriptorSchema, runManagedFiles } from './managed-files'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-storage-test-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function descriptor() {
  const { manifest, files } = packageFixture()
  await writeFile(join(root, 'proposal.json'), JSON.stringify({ schema: 'biometric-package-proposal-v1', manifest,
    files: [...files].map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })) }))
  const protocol = { schema: 'biometric-managed-protocol-v1', hardwareId: 'pod4', sampleRateHz: 500, metricId: 'heart_rate', minimumQuality: 0.8,
    alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' },
    uncertainty: { version: 'paired-night-percentile-v1', seed: 'fixture', resamples: 200, minimumNights: 3 }, resourcePolicy: fixtureResourceTestPolicy }
  const value = { schema: 'biometric-managed-descriptor-v1', study: { schema: 'biometric-package-study-v1', subjectId: 'fixture', side: 'left', protocolHash: configHash(protocol),
    nights: [{ id: 'night', startMs: 1791673200000, endMs: 1791673260000, inputHash: 'a'.repeat(64), referenceHash: 'b'.repeat(64), split: 'holdout' }] },
  protocol, split: 'holdout', idempotencyKey: 'test', variants: ['default', 'current', 'candidate'].map(label => ({ label, proposal: 'proposal.json', config: {}, seed: 1,
    policy: { image: 'sha256:' + 'c'.repeat(64), maximumWallMs: 5000, maximumMemoryBytes: 100000000, maximumProcesses: 1, maximumOutputBytes: 10000, maximumInputBytes: 10000 } })),
  nights: [{ id: 'night', frames: 'absent-frames', referenceImport: 'absent-reference' }] }
  await writeFile(join(root, 'descriptor.json'), JSON.stringify(value))
  return value
}
describe('managed workspace boundary', () => {
  it('rejects missing/extra night sources and protocol substitutions before opening inputs', async () => {
    const value = await descriptor()
    expect(managedDescriptorSchema.safeParse(value).success).toBe(true)
    for (const changed of [{ ...value, nights: [] }, { ...value, nights: [...value.nights, value.nights[0]] },
      { ...value, protocol: { ...value.protocol, minimumQuality: 0.1 } }]) {
      expect(managedDescriptorSchema.safeParse(changed).success).toBe(false)
    }
  })
  it('refuses public or symlinked workspaces', async () => {
    await descriptor()
    const publicPath = join(root, 'public')
    await mkdir(publicPath)
    await chmod(publicPath, 0o755)
    await expect(runManagedFiles(publicPath, join(root, 'descriptor.json'))).rejects.toThrow('private owned directory')
    const link = join(root, 'link')
    await symlink(root, link)
    await expect(runManagedFiles(link, join(root, 'descriptor.json'))).rejects.toThrow('private owned directory')
  })
  it('refuses linked databases and sidecars without changing their targets', async () => {
    await descriptor()
    const target = join(root, 'target')
    await writeFile(target, 'preserve me')
    for (const name of ['experiments.sqlite', 'experiments.sqlite-wal', 'experiments.sqlite-shm', 'experiments.sqlite-journal']) {
      const workspace = join(root, name + '-workspace')
      await mkdir(workspace, { mode: 0o700 })
      await symlink(target, join(workspace, name))
      await expect(runManagedFiles(workspace, join(root, 'descriptor.json'))).rejects.toThrow('Unsafe experiment database')
      expect(await readFile(target, 'utf8')).toBe('preserve me')
    }
  })
  it('refuses a foreign database and preserves its contents', async () => {
    await descriptor()
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { mode: 0o700 })
    const path = join(workspace, 'experiments.sqlite')
    const database = new Database(path)
    database.exec('CREATE TABLE vitals(value INTEGER); INSERT INTO vitals VALUES (60)')
    database.close()
    await chmod(path, 0o600)
    const before = await readFile(path)
    await expect(runManagedFiles(workspace, join(root, 'descriptor.json'))).rejects.toThrow('non-experiment database')
    expect(await readFile(path)).toEqual(before)
  })
})
