// @vitest-environment node
import { expect, it } from 'vitest'
import { nightUncertainty, type NightBootstrapPolicy } from '../uncertainty'
import { experimentProtocolSchema } from '../contracts'
import { configHash } from '../../algorithms/canonical'
const policy: NightBootstrapPolicy = { version: 'paired-night-percentile-v1', seed: 'fixture', resamples: 200, minimumNights: 3 }
const nights = [{ cohortId: 'a', difference: -0.5 }, { cohortId: 'b', difference: 0.2 }, { cohortId: 'c', difference: 0.8 }]
it('resamples paired nights reproducibly irrespective of input ordering', () => {
  const result = nightUncertainty(nights, policy)
  expect(result.status).toBe('estimated')
  expect(result).toEqual(nightUncertainty([...nights].reverse(), policy))
  expect(result.interval?.lower).toBeLessThan(result.estimate ?? 0)
  expect(result.interval?.upper).toBeGreaterThan(result.estimate ?? 0)
  expect(result).toMatchObject({ scoredNights: 3, omittedNights: 0, samplingUnit: 'whole_night_cohort' })
})
it('does not fabricate precision from missing or identical nights', () => {
  expect(nightUncertainty(nights)).toMatchObject({ status: 'not_requested', interval: null })
  expect(nightUncertainty([...nights.slice(0, 2), { cohortId: 'missing', difference: null }], policy))
    .toMatchObject({ status: 'insufficient_nights', scoredNights: 2, omittedNights: 1, interval: null })
  expect(nightUncertainty(nights.map(row => ({ ...row, difference: 0.5 })), policy)).toMatchObject({ status: 'degenerate', interval: null })
})
it('bounds computation and rejects invalid or duplicated evidence', () => {
  expect(() => nightUncertainty([...nights, nights[0]], policy)).toThrow('Invalid paired-night')
  expect(() => nightUncertainty([{ cohortId: 'bad', difference: NaN }], policy)).toThrow('Invalid paired-night')
  expect(() => nightUncertainty(nights, { ...policy, resamples: 5001 })).toThrow()
  expect(() => nightUncertainty(nights, { ...policy, minimumNights: 2 })).toThrow()
})
it('pins uncertainty parameters in the experiment protocol hash', () => {
  const base = { version: 'descriptive-evaluation-v1', mode: 'stage_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
  const first = experimentProtocolSchema.parse({ ...base, nightUncertainty: policy })
  const second = experimentProtocolSchema.parse({ ...base, nightUncertainty: { ...policy, seed: 'different' } })
  expect(configHash(first)).not.toBe(configHash(second))
  expect(experimentProtocolSchema.parse(base)).toEqual(base)
})

it('matches a separately computed Python SHA-256/quantile golden', () => {
  const fixture = Array.from({ length: 12 }, (_, i) => ({ cohortId: String(i).padStart(2, '0'), difference: ((i * 7) % 11 - 5) / 10 }))
  const result = nightUncertainty(fixture, policy)
  expect(result.estimate).toBeCloseTo(-0.041666666666666664, 14)
  expect(result.interval?.lower).toBeCloseTo(-0.22520833333333334, 14)
  expect(result.interval?.upper).toBeCloseTo(0.125, 14)
})
