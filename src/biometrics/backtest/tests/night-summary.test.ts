// @vitest-environment node
import { expect, it } from 'vitest'
import { compareStageOutputs } from '../stage-comparison'
import { summarizeStageNights } from '../night-summary'
import { previewReferenceImport } from '../../references/normalize'
const startMs = 1791673200000
function night(cohortId: string, duration: number, improved: boolean, missing = false) {
  const endMs = startMs + duration
  const references = missing
    ? []
    : previewReferenceImport({ side: 'left', subjectId: 'fixture', source: 'test', rows: [
      { recordKey: 'stage', metric: 'sleep_stages', value: 'light', unit: 'stage', startMs, endMs },
    ] }).measurements
  const score = compareStageOutputs([{ start: startMs, end: endMs, stage: improved ? 'deep' : 'light' }],
    [{ start: startMs, end: endMs, stage: improved ? 'light' : 'deep' }], references, startMs, endMs)
  return { cohortId, comparisons: [{ baseline: 'default', candidate: 'candidate', baselineHash: 'a', candidateHash: 'b', windows: [{ ...score, startMs, endMs }] }] }
}
it('keeps equal-night effects distinct from pooled duration effects and includes unscored nights', () => {
  const result = summarizeStageNights([night('long', 900000, true), night('short', 100000, false), night('unknown', 500000, true, true)])[0]
  expect(result).toMatchObject({ totalNights: 3, scoredNights: 2, unscoredNights: 1, improvedAgreementNights: 1,
    regressedAgreementNights: 1, equalNightMeanAgreementDifference: 0, observedNightRange: { minimum: -1, maximum: 1 } })
  expect(result.pooledCommonSupport.candidate.agreement).toBe(0.9)
  expect(result.pooledCommonSupport.baseline.agreement).toBe(0.1)
  expect(result.nights[2].commonAgreementDifference).toBeNull()
})
it('combines window confusion durations before computing nightly F1', () => {
  const first = night('one', 900000, true), second = night('two', 100000, false)
  second.comparisons[0].windows[0].startMs += 900000
  second.comparisons[0].windows[0].endMs += 900000
  first.comparisons[0].windows.push(second.comparisons[0].windows[0])
  const result = summarizeStageNights([first])[0]
  expect(result.nights[0].commonSupport.candidate.agreement).toBe(0.9)
  expect(result.nights[0].commonSupport.candidate.macroF1).toBeCloseTo(0.9 / 1.9)
  expect(result.nights[0].commonSupport.candidate.pairedDurationMs).toBe(1000000)
})
it('never merges different hashes or counts duplicated cohort/comparison evidence twice', () => {
  const first = night('one', 100000, true), second = night('two', 100000, true)
  second.comparisons[0].candidateHash = 'different'
  expect(summarizeStageNights([first, second])).toHaveLength(2)
  expect(() => summarizeStageNights([first, first])).toThrow('whole-night')
  first.comparisons.push(first.comparisons[0])
  expect(() => summarizeStageNights([first])).toThrow('Duplicate comparison')
})
it('keeps all-missing evidence unknown', () => {
  const result = summarizeStageNights([night('missing', 100000, true, true)])[0]
  expect(result.equalNightMeanAgreementDifference).toBeNull()
  expect(result.observedNightRange).toBeNull()
  expect(result.pooledCommonSupport.candidate.agreement).toBeNull()
  expect(summarizeStageNights([])).toEqual([])
})

it('rejects overlapping windows instead of double-counting their support', () => {
  const input = night('one', 100000, true)
  input.comparisons[0].windows.push(input.comparisons[0].windows[0])
  expect(() => summarizeStageNights([input])).toThrow('nonoverlapping')
})
