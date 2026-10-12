// @vitest-environment node
import { expect, it } from 'vitest'
import { previewReferenceImport } from '../../references/normalize'
import { compareStageOutputs } from '../stage-comparison'
const references = previewReferenceImport({ side: 'left', subjectId: 'fixture', source: 'test', rows: [
  { recordKey: 'first', metric: 'sleep_stages', value: 'light', unit: 'stage', startMs: 1791673200000, endMs: 1791673210000 },
  { recordKey: 'second', metric: 'sleep_stages', value: 'deep', unit: 'stage', startMs: 1791673210000, endMs: 1791673220000 },
] }).measurements
it('exposes apparent gains from dropping difficult intervals', () => {
  const comparison = compareStageOutputs([{ start: 1791673200000, end: 1791673220000, stage: 'light' }],
    [{ start: 1791673200000, end: 1791673210000, stage: 'light' }], references, 1791673200000, 1791673220000)
  expect(comparison.ownSupport.baseline.agreement).toBe(0.5)
  expect(comparison.ownSupport.candidate.agreement).toBe(1)
  expect(comparison.differences).toMatchObject({ ownAgreement: 0.5, commonAgreement: 0, referenceCoverage: -0.5, outputCoverage: -0.5, pairedDurationMs: -10000 })
  expect(comparison.coverageReduced).toBe(true)
  expect(comparison.commonSupport.baseline.pairedDurationMs).toBe(10000)
  expect(comparison.commonSupport.candidate.pairedDurationMs).toBe(10000)
})
it('measures genuine paired improvement without penalizing unchanged support', () => {
  const comparison = compareStageOutputs([{ start: 1791673200000, end: 1791673220000, stage: 'light' }],
    [{ start: 1791673200000, end: 1791673210000, stage: 'light' }, { start: 1791673210000, end: 1791673220000, stage: 'deep' }], references, 1791673200000, 1791673220000)
  expect(comparison.differences).toMatchObject({ commonAgreement: 0.5, referenceCoverage: 0, outputCoverage: 0 })
  expect(comparison.coverageReduced).toBe(false)
  expect(comparison.interpretation).toBe('descriptive_agreement_not_validated_improvement')
})
it('keeps no common support unknown instead of reporting zero error', () => {
  const comparison = compareStageOutputs([{ start: 1791673200000, end: 1791673210000, stage: 'light' }],
    [{ start: 1791673210000, end: 1791673220000, stage: 'deep' }], references, 1791673200000, 1791673220000)
  expect(comparison.commonSupport.baseline.pairedDurationMs).toBe(0)
  expect(comparison.differences.commonAgreement).toBeNull()
  expect(comparison.differences.commonMacroF1).toBeNull()
})
it('excludes conflicting references identically on both sides and never fills gaps', () => {
  const conflict = { ...references[0], recordKey: 'conflict', stage: 'rem' as const }
  const comparison = compareStageOutputs([{ start: 1791673200000, end: 1791673220000, stage: 'light' }],
    [{ start: 1791673200000, end: 1791673205000, stage: 'light' }, { start: 1791673215000, end: 1791673220000, stage: 'deep' }], [...references, conflict], 1791673200000, 1791673220000)
  expect(comparison.commonSupport.baseline.pairedDurationMs).toBe(5000)
  expect(comparison.commonSupport.candidate.pairedDurationMs).toBe(5000)
  expect(comparison.differences.commonAgreement).toBe(1)
})
