// @vitest-environment node
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createNumericNightSummary } from '../numeric-night-summary'
import { createNightUncertainty } from '../uncertainty-core'
import { compareNumericConfigurations } from '../numeric-comparison'
import { DEFAULT_ALIGNMENT } from '../../references/alignment'
import { previewReferenceImport } from '../../references/normalize'
const summarize = createNumericNightSummary(createNightUncertainty(text => createHash('sha256').update(text).digest(), 'equal_night_mean_common_mae_difference'))
const T = Date.UTC(2026, 9, 10)
const policy = { version: 'paired-night-percentile-v1' as const, seed: 'numeric', minimumNights: 3, resamples: 200 }
function window(offset: number, count: number, error: number, missing = false) {
  const observations = Array.from({ length: count }, (_, i) => ({ timestampMs: T + offset + i * 60000, value: 60 }))
  const references = missing ? [] : previewReferenceImport({ side: 'left', source: 'fixture', subjectId: 'fixture', rows: observations.map((row, i) => ({ recordKey: String(i), metric: 'heart_rate', timestampMs: row.timestampMs, value: 60, unit: 'bpm' })) }).measurements
  return { startMs: T + offset, endMs: T + offset + count * 60000, metrics: compareNumericConfigurations('heart_rate', null, [
    { label: 'default', configHash: 'baseline', observations },
    { label: 'candidate', configHash: 'candidate', observations: observations.map(row => ({ ...row, value: row.value + error })) },
  ], references, DEFAULT_ALIGNMENT) }
}
it('combines windows by paired reference count before giving nights equal weight', () => {
  const [result] = summarize([
    { cohortId: 'a', numericComparisons: [window(0, 1, 10), window(120000, 3, 2)] },
    { cohortId: 'b', numericComparisons: [window(0, 1, 0)] },
    { cohortId: 'missing', numericComparisons: [window(0, 1, 0, true)] },
  ], policy)
  expect(result).toMatchObject({ totalNights: 3, scoredNights: 2, unscoredNights: 1, equalNightMeanMaeDifference: 2,
    pooledCommonSupport: { candidate: { mae: 3.2, pairedCount: 5 } },
    uncertainty: { status: 'insufficient_nights', estimate: 2, omittedNights: 1, statistic: 'equal_night_mean_common_mae_difference' } })
  expect(result.nights[0].commonMaeDifference).toBe(4)
  expect(result.pooledCommonSupport.candidate).not.toHaveProperty('p95AbsoluteError')
})
it('bootstraps numeric differences above one in metric units reproducibly', () => {
  const nights = [2, 10, 30].map((error, i) => ({ cohortId: String(i), numericComparisons: [window(0, 1, error)] }))
  const [result] = summarize(nights, policy)
  expect(result.uncertainty.status).toBe('estimated')
  expect(result.uncertainty).toEqual(summarize([...nights].reverse(), policy)[0].uncertainty)
  expect(result.uncertainty.interval?.upper).toBeGreaterThan(10)
  expect(result.uncertainty.estimate).toBe(14)
})
it('keeps missing evidence unknown and rejects duplicate or overlapping evidence', () => {
  const night = { cohortId: 'one', numericComparisons: [window(0, 1, 0, true)] }
  expect(summarize([night])[0]).toMatchObject({ equalNightMeanMaeDifference: null, scoredNights: 0, uncertainty: { interval: null, estimate: null } })
  expect(() => summarize([night, night])).toThrow('cohorts')
  expect(() => summarize([{ ...night, numericComparisons: [window(0, 2, 0), window(60000, 1, 0)] }])).toThrow('windows')
  const duplicate = window(0, 1, 0)
  duplicate.metrics.push(duplicate.metrics[0])
  expect(() => summarize([{ ...night, numericComparisons: [duplicate] }])).toThrow('Duplicate')
})
it('does not combine different immutable configurations', () => {
  const first = window(0, 1, 2), second = window(0, 1, 3)
  second.metrics[0].candidateHash = 'other'
  expect(summarize([{ cohortId: 'a', numericComparisons: [first] }, { cohortId: 'b', numericComparisons: [second] }])).toHaveLength(2)
})
