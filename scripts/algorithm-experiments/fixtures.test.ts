import { fixtureResourceTestPolicy } from './resource-test-policy'
import { describe, expect, it } from 'vitest'
import { assessFixtureReadings, packageFixtureSuiteSchema } from './fixtures'
const numeric = { kind: 'numeric' as const, metric: 'heart_rate', startMs: 1000, endMs: 2000, minimum: 59, maximum: 61, minimumReadings: 2, minimumQuality: 0.8 }
const reading = { timestampMs: 1000, side: 'left' as const, metric: 'heart_rate', value: 60, quality: 1, flags: [] }
describe('artifact/noise fixture scoring', () => {
  it('requires coverage and rejects dropping difficult readings', () => {
    expect(assessFixtureReadings([numeric], [reading, { ...reading, timestampMs: 1500 }]).passed).toBe(true)
    expect(assessFixtureReadings([numeric], [reading]).failures).toContain('insufficient_coverage:heart_rate:0')
    expect(assessFixtureReadings([numeric], [{ ...reading, value: null }]).passed).toBe(false)
    expect(assessFixtureReadings([numeric], [reading, reading]).passed).toBe(false)
  })
  it('rejects out-of-range, low quality, unknown metric and out-of-window readings', () => {
    for (const changed of [{ ...reading, value: 120 }, { ...reading, quality: 0.2 }, { ...reading, timestampMs: 2000 }, { ...reading, metric: 'breathing_rate' }]) {
      expect(assessFixtureReadings([{ ...numeric, minimumReadings: 1 }], [changed]).passed).toBe(false)
    }
  })
  it('accepts explicit null or absent output for abstention, but rejects invented vitals', () => {
    const expected = { kind: 'abstain' as const, metric: 'heart_rate', startMs: 1000, endMs: 2000 }
    expect(assessFixtureReadings([expected], []).passed).toBe(true)
    expect(assessFixtureReadings([expected], [{ ...reading, value: null }]).passed).toBe(true)
    expect(assessFixtureReadings([expected], [reading]).failures).toContain('failed_abstention:heart_rate:1000')
  })
  it('rejects overlapping, vacuous, out-of-input and duplicate fixture definitions', () => {
    const fixture = { id: 'clean', category: 'clean_signal',
      request: { schema: 'biometric-package-run-v1', packageHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), hardwareId: 'pod4', sampleRateHz: 1, side: 'left', seed: 1, config: {} },
      frames: [{ schema: 'biometric-signal-frame-v1', sequence: 0, timestampMs: 1000, samples: { left: [1], right: null }, context: { occupied: true, pumpActive: false } }], expectations: [numeric] }
    const suite = (fixtures: unknown[]) => ({ schema: 'biometric-package-fixtures-v1', resourcePolicy: fixtureResourceTestPolicy, fixtures })
    expect(packageFixtureSuiteSchema.safeParse(suite([fixture])).success).toBe(true)
    for (const fixtures of [[fixture, fixture], [{ ...fixture, expectations: [numeric, numeric] }],
      [{ ...fixture, expectations: [{ ...numeric, startMs: 0 }] }], [{ ...fixture, category: 'empty_bed' }],
      [{ ...fixture, expectations: [{ kind: 'abstain', metric: 'heart_rate', startMs: 1000, endMs: 2000 }] }]]) {
      expect(packageFixtureSuiteSchema.safeParse(suite(fixtures)).success).toBe(false)
    }
  })
  it('rejects empty suites', () => {
    expect(packageFixtureSuiteSchema.safeParse({ schema: 'biometric-package-fixtures-v1', resourcePolicy: fixtureResourceTestPolicy, fixtures: [] }).success).toBe(false)
  })
})
