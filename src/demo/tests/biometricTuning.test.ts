// @vitest-environment node
import { expect, it } from 'vitest'
import { biometricTuning as handlers } from '../handlers/biometricTuning'
import { manifestHash, resolveConfig } from '@/src/biometrics/algorithms/registry'
import { profileOverviewSchema, revisionSchema } from '@/src/biometrics/profiles/contracts'
function required<T>(value: T | undefined): T {
  if (!value) throw new Error('Missing demo handler')
  return value
}
it('uses the real manifest, resolution and canonical hashes in the browser demo', async () => {
  const manifest = await required(handlers.getManifest)({})
  expect(manifest.manifestHash).toBe(manifestHash)
  const overrides = [{ path: 'sleep_stages.ruleset.lowSignalBelow', value: 0 }]
  expect(await required(handlers.resolveProfile)({ overrides, baseManifestHash: manifestHash })).toEqual(resolveConfig(overrides))
  await expect(required(handlers.resolveProfile)({ overrides: [{ path: 'heart_rate.trackingHistoryLength', value: 2.5 }] })).rejects.toThrow('Invalid biometric parameter')
  const overview = profileOverviewSchema.parse(await required(handlers.getProfileOverview)({ side: 'left' }))
  expect(overview.stageView.provenance.source).toBe('demo')
  expect(overview.runtimeStatus).toBe('unreported')
  expect(overview.desired.hash).toBe(resolveConfig([]).hash)
})
it('saves immutable candidates idempotently, isolates sides and rejects changed retries', async () => {
  const input = { side: 'left' as const, origin: 'manual' as const, requester: 'demo-test', idempotencyKey: 'candidate-test', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] }
  const create = required(handlers.createProfileRevision)
  const candidate = revisionSchema.parse(await create(input))
  expect(candidate.resolvedHash).toBe(resolveConfig(input.overrides).hash)
  expect(await create({ ...input, baseManifestHash: manifestHash })).toEqual(candidate)
  await expect(create({ ...input, overrides: [] })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  await expect(create({ ...input, side: 'right' })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  candidate.overrides.length = 0
  expect((await required(handlers.getProfileRevision)({ id: candidate.id })).overrides).toHaveLength(1)
  expect((await required(handlers.listProfileRevisions)({ side: 'right' })).items).toEqual([])
  const child = await create({ ...input, idempotencyKey: 'child-test', parentRevisionId: candidate.id })
  expect(child.familyId).toBe(candidate.familyId)
  expect(child.revision).toBe(2)
  await expect(create({ ...input, idempotencyKey: 'wrong-side-child', side: 'right', parentRevisionId: candidate.id })).rejects.toThrow('wrong side')
})
