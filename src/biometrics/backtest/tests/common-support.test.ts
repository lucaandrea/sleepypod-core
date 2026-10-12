// @vitest-environment node
import { expect, it } from 'vitest'
import { intersectOutputSupport, restrictToSupport } from '../common-support'
import { compareStageOutputs } from '../stage-comparison'
import { previewReferenceImport } from '../../references/normalize'
it('intersects all three outputs and clips boundaries without filling gaps', () => {
  const outputs = [[{ start: 0, end: 100 }], [{ start: 10, end: 40 }, { start: 50, end: 90 }], [{ start: 20, end: 60 }]]
  const before = JSON.stringify(outputs)
  expect(intersectOutputSupport(outputs, 25, 80)).toEqual([{ start: 25, end: 40 }, { start: 50, end: 60 }])
  expect(JSON.stringify(outputs)).toBe(before)
  expect(intersectOutputSupport([outputs[0], [], outputs[2]], 0, 100)).toEqual([])
})
it('preserves stage labels while rejecting ambiguous support', () => {
  expect(restrictToSupport([{ start: 0, end: 10, stage: 'deep' }], [{ start: 2, end: 4 }, { start: 6, end: 8 }]))
    .toEqual([{ start: 2, end: 4, stage: 'deep' }, { start: 6, end: 8, stage: 'deep' }])
  expect(() => intersectOutputSupport([[{ start: 0, end: 10 }, { start: 5, end: 15 }]], 0, 20)).toThrow('nonoverlapping')
  expect(() => intersectOutputSupport([], 0, 20)).toThrow('bounded')
})
it('scores every pair on the same three-way denominator while keeping own coverage', () => {
  const start = 1791673200000, end = start + 20000
  const full = [{ start, end, stage: 'light' as const }]
  const current = [{ start, end, stage: 'deep' as const }]
  const candidate = [{ start, end: start + 10000, stage: 'light' as const }]
  const refs = previewReferenceImport({ side: 'left', subjectId: 'fixture', source: 'test', rows: [
    { recordKey: 'stage', metric: 'sleep_stages', value: 'light', unit: 'stage', startMs: start, endMs: end },
  ] }).measurements
  const support = intersectOutputSupport([full, current, candidate], start, end)
  for (const [baseline, evaluated] of [[full, current], [full, candidate], [current, candidate]]) {
    const comparison = compareStageOutputs(baseline, evaluated, refs, start, end, support)
    expect(comparison.commonSupportScope).toBe('all_configurations')
    expect(comparison.commonSupport.baseline.pairedDurationMs).toBe(10000)
    expect(comparison.commonSupport.candidate.pairedDurationMs).toBe(10000)
  }
  const comparison = compareStageOutputs(full, current, refs, start, end, support)
  expect(comparison.ownSupport.baseline.pairedDurationMs).toBe(20000)
  expect(comparison.ownSupport.candidate.pairedDurationMs).toBe(20000)
  expect(compareStageOutputs(full, current, refs, start, end, []).differences.commonAgreement).toBeNull()
})
