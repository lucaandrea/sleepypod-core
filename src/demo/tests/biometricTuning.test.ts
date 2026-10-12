// @vitest-environment node
import { expect, it, vi } from 'vitest'
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
  const candidate = revisionSchema.parse(await create({ ...input, parentRevisionId: undefined }))
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

it('compares exact intent and simulates adoption, stale requests, rollback and reset without claiming real health', async () => {
  const create = required(handlers.createProfileRevision)
  const candidate = await create({ side: 'right', origin: 'manual', requester: 'demo-test', idempotencyKey: 'activation-candidate', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] })
  const diff = await required(handlers.diffProfileRevision)({ side: 'right', revisionId: candidate.id, againstRevisionId: null })
  expect(diff.afterHash).toBe(candidate.resolvedHash)
  expect(diff.changes.map(row => row.path)).toEqual(['heart_rate.trackingToleranceBpm'])
  expect(diff.intentChangedPaths).toEqual(['heart_rate.trackingToleranceBpm'])
  const request = { side: 'right' as const, revisionId: candidate.id, expectedGeneration: 0, expectedResolvedHash: candidate.resolvedHash, boundary: 'next_session' as const, requester: 'demo-test', idempotencyKey: 'activation-request', allowUnvalidated: true as const }
  const event = await required(handlers.activateProfile)(request)
  expect(event.state).toBe('pending_boundary')
  expect(event.reason).toContain('SIMULATED DEMO')
  expect(await required(handlers.activateProfile)(request)).toEqual(event)
  const status = await required(handlers.getActivationStatus)({ side: 'right', id: event.id })
  expect(status.observedState).toBe('pending_boundary')
  expect(status.receiptHealth.state).toBe('unreported')
  expect(status.receipts).toEqual([])
  const clock = vi.spyOn(Date, 'now').mockReturnValue(event.createdAtMs + 4000)
  try {
    const applied = await required(handlers.getActivationStatus)({ side: 'right', id: event.id })
    expect(applied.observedState).toBe('applied')
    expect(applied.receiptHealth.state).toBe('unreported')
    const overview = await required(handlers.getProfileOverview)({ side: 'right' })
    expect(overview.stageView.provenance.bundleHash).toBe(candidate.resolvedHash)
    expect(overview.stageView.provenance.source).toBe('demo')
  }
  finally {
    clock.mockRestore()
  }
  await expect(required(handlers.activateProfile)({ ...request, idempotencyKey: 'stale-request' })).rejects.toThrow('STALE_BINDING')
  const defaults = resolveConfig([])
  const rollback = await required(handlers.rollbackProfile)({ ...request, revisionId: null, expectedGeneration: 1, expectedResolvedHash: defaults.hash, idempotencyKey: 'rollback-request' })
  expect(rollback.action).toBe('rollback')
  expect(rollback.nextRevisionId).toBeNull()
  expect((await required(handlers.getActivationStatus)({ side: 'right', id: event.id })).isCurrent).toBe(false)
  const reset = await required(handlers.resetProfile)({ side: 'right', expectedGeneration: 2, expectedResolvedHash: defaults.hash, boundary: 'immediate', requester: 'demo-test', idempotencyKey: 'reset-request', allowUnvalidated: true })
  expect(reset.action).toBe('reset')
  expect((await required(handlers.listActivationHistory)({ side: 'right' })).items.map(row => row.action)).toEqual(['reset', 'rollback', 'activate'])
})

it('serializes concurrent activation requests so only one can consume a generation', async () => {
  const candidate = await required(handlers.createProfileRevision)({ side: 'left', origin: 'manual', requester: 'demo-test', idempotencyKey: 'race-candidate', overrides: [] })
  const request = { side: 'left' as const, revisionId: candidate.id, expectedGeneration: 0, expectedResolvedHash: candidate.resolvedHash, boundary: 'immediate' as const, requester: 'demo-test', allowUnvalidated: true as const }
  const outcomes = await Promise.allSettled(['race-a', 'race-b'].map(idempotencyKey => required(handlers.activateProfile)({ ...request, idempotencyKey })))
  expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
  expect((await required(handlers.getProfileOverview)({ side: 'left' })).desired.binding.generation).toBe(1)
})
