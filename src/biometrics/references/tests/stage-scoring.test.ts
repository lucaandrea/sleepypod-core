import { describe, expect, it } from 'vitest'
import { previewReferenceImport } from '../normalize'
import { scoreStageDurations } from '../stage-scoring'
const start = 1791673200000
const ref = (segments: Array<[number, number, string]>) => previewReferenceImport({ side: 'left', source: 'fixture', subjectId: 'A', rows:
  segments.map(([from, to, value], i) => ({ recordKey: String(i), metric: 'sleep_stages', value, unit: 'stage', startMs: start + from, endMs: start + to })) }).measurements

describe('duration weighted stage agreement', () => {
  it('scores partial epochs by duration and reports unsupported classes without invented zero scores', () => {
    const result = scoreStageDurations([{ start, end: start + 300000, stage: 'light' }], ref([[0, 100000, 'light'], [100000, 300000, 'deep']]), start, start + 600000)
    expect(result).toMatchObject({ agreement: 1 / 3, pairedDurationMs: 300000, unscoredDurationMs: 300000, outputCoverage: 0.5, referenceTransitions: 1, predictedTransitions: 0 })
    expect(result.confusionMs.deep.light).toBe(200000)
    expect(result.perStage.find(row => row.stage === 'wake')).toMatchObject({ precision: null, recall: null, f1: null, supportMs: 0 })
    expect(result.perStage.find(row => row.stage === 'deep')).toMatchObject({ f1: 0, recall: 0, durationDifferenceMs: -200000 })
  })
  it('excludes conflicting cross-import overlap and collapses duplicate labels without double counting', () => {
    const refs = [...ref([[0, 300000, 'light']]), ...ref([[100000, 200000, 'deep']]), ...ref([[0, 300000, 'light']])]
    const result = scoreStageDurations([{ start, end: start + 300000, stage: 'light' }], refs, start, start + 300000)
    expect(result).toMatchObject({ pairedDurationMs: 200000, conflictingReferenceMs: 100000, agreement: 1, predictedTransitions: 0, referenceTransitions: 0 })
  })
  it('leaves unknown stages and gaps unscored and rejects overlapping predictions', () => {
    const result = scoreStageDurations([], ref([[0, 1000, 'unknown']]), start, start + 1000)
    expect(result).toMatchObject({ status: 'no_scorable_reference', agreement: null, macroF1: null, unscoredDurationMs: 1000 })
    expect(() => scoreStageDurations([{ start, end: start + 20, stage: 'wake' }, { start: start + 10, end: start + 30, stage: 'light' }], [], start, start + 1000)).toThrow('nonoverlapping')
  })
})
