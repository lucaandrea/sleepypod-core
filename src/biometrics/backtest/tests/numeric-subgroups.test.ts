// @vitest-environment node
import { expect, it } from 'vitest'
import { subgroupReferences, subgroupBoundaryExclusions, subgroupObjectiveEvidence } from '../numeric-subgroups'
import { previewReferenceImport } from '../../references/normalize'
const T = Date.UTC(2026, 9, 10)
const window = { startMs: T, endMs: T + 120000 }
const rows = previewReferenceImport({ side: 'left', source: 'test', subjectId: 'test', rows: [
  { recordKey: 'early', metric: 'heart_rate', timestampMs: T, value: 60, unit: 'bpm' },
  { recordKey: 'middle', metric: 'heart_rate', timestampMs: T + 60000, value: 60, unit: 'bpm' },
  { recordKey: 'first', metric: 'heart_rate', startMs: T, endMs: T + 60000, value: 60, unit: 'bpm', aggregation: 'mean' },
  { recordKey: 'spanning', metric: 'heart_rate', startMs: T + 30000, endMs: T + 90000, value: 60, unit: 'bpm', aggregation: 'mean' },
] }).measurements
it('keeps point/interval semantics and midpoint boundaries without splitting reference records', () => {
  expect(subgroupReferences('reference_points', rows, window).map(row => row.recordKey)).toEqual(['early', 'middle'])
  expect(subgroupReferences('reference_intervals', rows, window).map(row => row.recordKey)).toEqual(['first', 'spanning'])
  expect(subgroupReferences('window_first_half', rows, window).map(row => row.recordKey)).toEqual(['early', 'first'])
  expect(subgroupReferences('window_second_half', rows, window).map(row => row.recordKey)).toEqual(['middle'])
  expect(subgroupBoundaryExclusions('window_first_half', rows, window)).toBe(1)
  expect(subgroupBoundaryExclusions('reference_intervals', rows, window)).toBe(0)
})
it('weights supported nights equally and never hides unsupported nights in the subgroup mean', () => {
  const identity = { baseline: 'default', candidate: 'candidate', metric: 'heart_rate', baselineHash: 'a', candidateHash: 'b' }
  const nights = [{ commonMaeDifference: -4, commonSupport: { candidate: { pairedCount: 100 } } }, { commonMaeDifference: 6, commonSupport: { candidate: { pairedCount: 10 } } }]
  const summary = { ...identity, name: 'window_second_half', nights }
  expect(subgroupObjectiveEvidence([summary], identity, 10)).toEqual([{ name: 'window_second_half', pairedNights: 2, maeDifference: 1 }])
  expect(subgroupObjectiveEvidence([summary], identity, 11)).toEqual([{ name: 'window_second_half', pairedNights: 1, maeDifference: null }])
  expect(subgroupObjectiveEvidence([summary], { ...identity, candidateHash: 'different' }, 10)).toEqual([])
})
