import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STAGE_CLASSIFIER, MOVEMENT_ONLY_STAGE_RULESET, type StageClassifier } from '@/src/lib/sleep-stage-rules'
import { demoNights } from '../history'
import type { sleepStages as SleepStageHandlers } from '../handlers/sleepStages'
import type { biometricTuning as ProfileHandlers } from '../handlers/biometricTuning'
let sleepStages: typeof SleepStageHandlers
let profiles: typeof ProfileHandlers

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

const NOW = Date.UTC(2026, 9, 10, 12)
const movementOnly: StageClassifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }

describe('demo sleepStages', () => {
  beforeEach(async () => {
    vi.resetModules()
    sleepStages = (await import('../handlers/sleepStages')).sleepStages
    profiles = (await import('../handlers/biometricTuning')).biometricTuning
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(async () => {
    vi.useRealTimers()
  })

  it('keeps a classifier per side for the session', async () => {
    expect((await required(sleepStages.getClassifier)({ side: 'left' })).isDefault).toBe(true)
    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    const pending = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(pending.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
    expect(pending.pending?.classifier).toEqual(movementOnly)
    vi.setSystemTime(NOW + 1000)
    const left = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(left).toMatchObject({ classifier: movementOnly, isDefault: false, defaults: DEFAULT_STAGE_CLASSIFIER })
    expect((await required(sleepStages.getClassifier)({ side: 'right' })).isDefault).toBe(true)
  })

  it('previews the latest night against the scripted hypnogram', async () => {
    const out = await required(sleepStages.previewClassifier)({ side: 'left', classifier: movementOnly })
    expect(out.sleepRecordId).toBe(demoNights('left')[0].id)
    expect(out.hasReference).toBe(true)
    expect(out.candidate?.distribution.deep).toBe(0)
    expect(out.candidate?.agreement?.epochs).toBeGreaterThan(0)
    expect(out.saved).not.toBeNull()
  })

  it('rejects another side\'s night', async () => {
    const right = demoNights('right')[0]
    await expect(required(sleepStages.previewClassifier)({ side: 'left', sleepRecordId: right.id, classifier: movementOnly }))
      .rejects.toThrow(/not found for side 'left'/)
  })
  it('shares adopted rules and provenance with calibration while preserving numerical overrides on stage reset', async () => {
    const revision = await required(profiles.createProfileRevision)({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }], origin: 'manual', requester: 'test', idempotencyKey: 'numeric' })
    await required(profiles.activateProfile)({ side: 'left', revisionId: revision.id, expectedGeneration: 0, expectedResolvedHash: revision.resolvedHash,
      boundary: 'immediate', requester: 'test', idempotencyKey: 'activate-numeric', allowUnvalidated: true })
    const write = await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    expect(write.activation.generation).toBe(2)
    vi.setSystemTime(NOW + 1000)
    const stage = await required(sleepStages.getClassifier)({ side: 'left' })
    const overview = await required(profiles.getProfileOverview)({ side: 'left' })
    expect(stage.classifier).toEqual(movementOnly)
    expect(stage.provenance).toEqual(overview.stageView.provenance)
    expect(overview.desired.resolved.heart_rate.trackingToleranceBpm).toBe(20)
    await required(sleepStages.setClassifier)({ side: 'left', classifier: null })
    vi.setSystemTime(NOW + 2000)
    const reset = await required(profiles.getProfileOverview)({ side: 'left' })
    expect(reset.desired.resolved.heart_rate.trackingToleranceBpm).toBe(20)
    expect(reset.stageView.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
    expect(reset.stageView.isDefault).toBe(true)
    expect(reset.desired.isDefault).toBe(false)
    expect((await required(profiles.listActivationHistory)({ side: 'left' })).items).toHaveLength(3)
  })

  it('previews saved rules from the adopted profile rather than a second settings store', async () => {
    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    vi.setSystemTime(NOW + 1000)
    const preview = await required(sleepStages.previewClassifier)({ side: 'left', classifier: movementOnly })
    expect(preview.saved).toEqual(preview.candidate)
    expect(preview.saved?.distribution.deep).toBe(0)
  })

  it('recomputes historical chart stages with adopted rules and exposes the same profile identity', async () => {
    const { biometrics } = await import('../handlers/biometrics')
    const night = demoNights('left')[0]
    const before = await required(biometrics.getSleepStages)({ side: 'left', sleepRecordId: night.id })
    await required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly })
    const pending = await required(biometrics.getSleepStages)({ side: 'left', sleepRecordId: night.id })
    expect(pending.epochs).toEqual(before.epochs)
    vi.setSystemTime(NOW + 1000)
    const chart = await required(biometrics.getSleepStages)({ side: 'left', sleepRecordId: night.id })
    const preview = await required(sleepStages.previewClassifier)({ side: 'left', sleepRecordId: night.id, classifier: movementOnly })
    expect(chart.blocks).toEqual(preview.saved?.blocks)
    expect(chart.distribution.deep).toBe(0)
    expect(chart.stageView?.provenance).toEqual((await required(profiles.getProfileOverview)({ side: 'left' })).stageView.provenance)
  })

  it('serializes compatibility writes without losing the preceding desired revision', async () => {
    const results = await Promise.all([
      required(sleepStages.setClassifier)({ side: 'left', classifier: movementOnly }),
      required(sleepStages.setClassifier)({ side: 'left', classifier: null }),
    ])
    expect(results.map(result => result.activation.generation)).toEqual([1, 2])
    vi.setSystemTime(NOW + 1000)
    const final = await required(sleepStages.getClassifier)({ side: 'left' })
    expect(final.isDefault).toBe(true)
    expect(final.provenance.generation).toBe(2)
  })
})
