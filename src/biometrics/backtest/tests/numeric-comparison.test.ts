// @vitest-environment node
import { expect, it } from 'vitest'
import { compareNumericConfigurations } from '../numeric-comparison'
import { DEFAULT_ALIGNMENT } from '../../references/alignment'
import { previewReferenceImport } from '../../references/normalize'

const T = Date.UTC(2026, 9, 10, 23)
const refs = (rows: unknown[]) => previewReferenceImport({ side: 'left', source: 'test', subjectId: 'test', rows }).measurements
const point = (timestampMs: number, value = 60) => ({ recordKey: String(timestampMs), metric: 'heart_rate', timestampMs, value, unit: 'bpm' })
const output = (label: 'default' | 'current' | 'candidate', rows: [number, number | null][]) => ({ label, configHash: label,
  observations: rows.map(([offset, value]) => ({ timestampMs: T + offset, value })) })

it('exposes dropped difficult readings despite improved own-support error', () => {
  const [result] = compareNumericConfigurations('heart_rate', null,
    [output('default', [[0, 60], [60000, 100]]), output('candidate', [[0, 60]])],
    refs([point(T), point(T + 60000)]), DEFAULT_ALIGNMENT)
  expect(result).toMatchObject({ commonObservationCount: 1, lostObservationTimestamps: 1, addedObservationTimestamps: 0,
    coverageReduced: true, differences: { ownMae: -20, commonMae: 0, referenceCoverage: -0.5 } })
})
it('recomputes interval aggregation on identical sample support', () => {
  const [result] = compareNumericConfigurations('heart_rate', null,
    [output('default', [[0, 60], [60000, 100]]), output('candidate', [[0, 60]])],
    refs([{ recordKey: 'interval', metric: 'heart_rate', startMs: T, endMs: T + 120000, value: 60, unit: 'bpm', aggregation: 'mean' }]), DEFAULT_ALIGNMENT)
  expect(result.differences).toMatchObject({ ownMae: -20, commonMae: 0 })
  expect(result.commonSupport.baseline.metrics?.mae).toBe(0)
})
it('uses all three configurations even for the default-current comparison', () => {
  const results = compareNumericConfigurations('heart_rate', null,
    [output('default', [[0, 60], [60000, 90]]), output('current', [[0, 62], [60000, 60]]), output('candidate', [[0, 61]])],
    refs([point(T), point(T + 60000)]), DEFAULT_ALIGNMENT)
  expect(results).toHaveLength(3)
  expect(results.every(result => result.commonObservationCount === 1)).toBe(true)
  expect(results.find(result => result.candidate === 'current')?.differences.commonMae).toBe(2)
})
it('does not treat nearby output timestamps as common support', () => {
  const [result] = compareNumericConfigurations('heart_rate', null,
    [output('default', [[0, 60]]), output('candidate', [[1, 60]])], refs([point(T)]), DEFAULT_ALIGNMENT)
  expect(result).toMatchObject({ commonObservationCount: 0, differences: { commonMae: null, ownMae: 0 },
    lostObservationTimestamps: 1, addedObservationTimestamps: 1 })
})
it('excludes duplicate timestamps including null-value duplicates', () => {
  const [result] = compareNumericConfigurations('heart_rate', null,
    [output('default', [[0, 60], [0, null], [60000, 60]]), output('candidate', [[0, 60], [60000, 62]])],
    refs([point(T), point(T + 60000)]), DEFAULT_ALIGNMENT)
  expect(result).toMatchObject({ commonObservationCount: 1, ambiguousObservationTimestamps: { baseline: 1, candidate: 0 },
    differences: { commonMae: 2, commonSignedBias: 2 } })
})
it('preserves fixed clock offsets and null metrics without compatible reference evidence', () => {
  const outputs = [output('default', [[0, 60]]), output('candidate', [[0, 62]])]
  const [shifted] = compareNumericConfigurations('heart_rate', null, outputs, refs([point(T + 60000)]),
    { ...DEFAULT_ALIGNMENT, pointToleranceMs: 0, clockOffsetMs: 60000 })
  expect(shifted.differences.commonMae).toBe(2)
  const [missing] = compareNumericConfigurations('heart_rate', null, outputs, [], DEFAULT_ALIGNMENT)
  expect(missing.differences.commonMae).toBeNull()
  const [incompatible] = compareNumericConfigurations('window_ibi_variability_v1', 300000, outputs,
    refs([{ recordKey: 'watch', metric: 'hrv_rmssd', timestampMs: T, value: 40, unit: 'ms', windowMs: 300000 }]), DEFAULT_ALIGNMENT)
  expect(incompatible.commonSupport.baseline.status).toBe('incompatible')
  expect(incompatible.differences.commonMae).toBeNull()
})
