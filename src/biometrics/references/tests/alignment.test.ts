// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { alignReferences, DEFAULT_ALIGNMENT } from '../alignment'
import { previewReferenceImport } from '../normalize'

const T = Date.UTC(2026, 9, 10, 23)
function refs(rows: unknown[]) {
  return previewReferenceImport({ side: 'left', source: 'test', subjectId: 'test', rows }).measurements
}
const point = (key: string, timestampMs: number, value: number) => ({ recordKey: key, metric: 'heart_rate', timestampMs, unit: 'bpm', value })

describe('fixed-protocol reference alignment', () => {
  it('pairs each point once, reports signed error and full output coverage, and never forward-fills sparse references', () => {
    const reference = refs([point('one', T, 60), point('two', T + 600000, 70)])
    const result = alignReferences('heart_rate', null, [{ timestampMs: T + 1000, value: 62 }, { timestampMs: T + 61000, value: 60 }, { timestampMs: T + 120000, value: null }], reference)
    expect(result).toMatchObject({ pairedCount: 1, pairedDurationMs: 0, eligibleReferences: 2, referenceCoverage: 0.5, outputCoverage: 2 / 3, unmatchedReferences: 1, unmatchedObservations: 1,
      metrics: { mae: 2, medianAbsoluteError: 2, p95AbsoluteError: 2, signedBias: 2 } })
  })

  it('deduplicates equivalent references and never reuses one pod observation for several nearby references', () => {
    const result = alignReferences('heart_rate', null, [{ timestampMs: T, value: 60 }], refs([point('one', T, 60), point('duplicate', T, 60), point('nearby', T + 1000, 61)]))
    expect(result).toMatchObject({ pairedCount: 1, duplicateReferences: 1, eligibleReferences: 2, unmatchedReferences: 1 })
  })

  it('aggregates interval observations and counts only known support, without fabricating coverage across gaps', () => {
    const references = refs([{ recordKey: 'interval', metric: 'heart_rate', startMs: T, endMs: T + 300000, value: 60, unit: 'bpm', aggregation: 'mean' }])
    const result = alignReferences('heart_rate', null, [{ timestampMs: T, value: 58, durationMs: 60000 }, { timestampMs: T + 240000, value: 66, durationMs: 60000 }, { timestampMs: T + 300000, value: 80, durationMs: 60000 }], references)
    expect(result).toMatchObject({ pairedCount: 1, pairedDurationMs: 120000, matchedObservationCount: 2, metrics: { mae: 2, signedBias: 2 } })
    expect(result.pairs[0].podCount).toBe(2)
  })

  it('uses a frozen supplied offset and correctly handles mixed interval and point search windows', () => {
    const references = refs([{ recordKey: 'interval', metric: 'heart_rate', startMs: T + 100000, endMs: T + 101000, value: 60, unit: 'bpm' }, point('point', T + 110000, 62)])
    const result = alignReferences('heart_rate', null, [{ timestampMs: T + 90000, value: 62 }, { timestampMs: T + 100000, value: 60 }], references)
    expect(result.pairedCount).toBe(2)
    const shifted = alignReferences('heart_rate', null, [{ timestampMs: T - 60000, value: 60 }], refs([point('one', T, 60)]), { ...DEFAULT_ALIGNMENT, clockOffsetMs: 60000, offsetSource: 'training' })
    expect(shifted.pairedCount).toBe(1)
    expect(shifted.policy.clockOffsetMs).toBe(60000)
  })

  it('blocks incompatible HRV definitions and windows instead of returning an invalid score with a warning', () => {
    const incompatible = refs([{ recordKey: 'watch', metric: 'hrv_rmssd', value: 40, unit: 'ms', timestampMs: T, windowMs: 300000 }])
    const result = alignReferences('window_ibi_variability_v1', 300000, [{ timestampMs: T, value: 40 }], incompatible)
    expect(result).toMatchObject({ status: 'incompatible', metrics: null, pairedCount: 0, exclusions: { incompatible_metric_definition: 1 } })
    const unknownWindow = refs([{ recordKey: 'window', metric: 'window_ibi_variability_v1', value: 40, unit: 'ms', timestampMs: T, aggregation: 'window_index' }])
    expect(alignReferences('window_ibi_variability_v1', 300000, [{ timestampMs: T, value: 40 }], unknownWindow).metrics).toBeNull()
    expect(alignReferences('heart_rate', null, [], []).status).toBe('no_reference')
  })

  it('rejects invalid policies and nonfinite observations', () => {
    expect(() => alignReferences('heart_rate', null, [], [], { ...DEFAULT_ALIGNMENT, pointToleranceMs: -1 })).toThrow()
    expect(() => alignReferences('heart_rate', null, [{ timestampMs: T, value: NaN }], [])).toThrow()
  })
})
