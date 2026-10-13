import { describe, expect, it } from 'vitest'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { packageFixture } from '../../src/biometrics/packages/tests/fixture'
import { comparePackageOutputs } from './comparison'
const start = 1791673200000
function fixture() {
  const outputs = (['default', 'current', 'candidate'] as const).map((label, index) => {
    const { manifest } = packageFixture()
    const declared = { ...manifest, metrics: manifest.metrics.map(metric => ({ ...metric, reference: { metric: 'heart_rate', windowMs: null as number | null } })) }
    const packageHash = configHash(declared)
    const request = { schema: 'biometric-package-run-v1', packageHash, inputHash: 'a'.repeat(64), hardwareId: 'pod4', sampleRateHz: 500, side: 'left', seed: 1, config: { offset: index } }
    const runHash = configHash(request)
    return { label, manifest: declared, request, result: { packageHash, runHash,
      frozenInput: { schema: 'biometric-package-input-v1', hash: request.inputHash, bytes: 1000, frameCount: 1 },
      results: [{ schema: 'biometric-metric-frame-v1', runHash, frameHash: 'b'.repeat(64), sequence: 0, state: {},
        readings: [0, 60000].map(offset => ({ timestampMs: start + offset, side: 'left', metric: 'heart_rate', value: 64 - index * 2 as number | null, quality: 1, flags: [] })) }] } }
  })
  return { schema: 'biometric-package-comparison-v1', metricId: 'heart_rate', startMs: start, endMs: start + 120000, minimumQuality: 0.8,
    referenceImport: { side: 'left', subjectId: 'fixture', source: 'synthetic', rows: [0, 60000].map((offset, index) => ({ recordKey: String(index), metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: start + offset })) },
    alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' }, outputs }
}
function rebind(output: ReturnType<typeof fixture>['outputs'][number]) {
  output.request.packageHash = configHash(output.manifest)
  output.result.packageHash = output.request.packageHash
  output.result.runHash = configHash(output.request)
  output.result.results.forEach((frame) => {
    frame.runHash = output.result.runHash
  })
}
describe('package reference agreement', () => {
  it('compares both baselines with shared pairing without granting promotion', () => {
    const result = comparePackageOutputs(fixture())
    expect(result.comparisons.filter(row => row.candidate === 'candidate').map(row => row.differences.commonMae)).toEqual([-4, -2])
    expect(result.interpretation).toContain('not_independent_holdout_or_promotion')
  })
  it('exposes dropped and low-quality values as lost support', () => {
    for (const lowQuality of [false, true]) {
      const input = fixture()
      const row = input.outputs[2].result.results[0].readings[0]
      if (lowQuality) row.quality = 0.1
      else row.value = null
      const comparison = comparePackageOutputs(input).comparisons.find(row => row.candidate === 'candidate' && row.baseline === 'default')
      expect(comparison).toMatchObject({ coverageReduced: true, lostObservationTimestamps: 1, commonObservationCount: 1 })
    }
  })
  it('rejects substituted run, frame, input, side and duplicate baseline identities', () => {
    for (const change of [
      (input: ReturnType<typeof fixture>) => { input.outputs[2].result.runHash = 'c'.repeat(64) },
      (input: ReturnType<typeof fixture>) => { input.outputs[2].result.results[0].frameHash = 'c'.repeat(64) },
      (input: ReturnType<typeof fixture>) => { input.outputs[2].request.side = 'right' },
      (input: ReturnType<typeof fixture>) => { input.outputs[2].request.inputHash = 'c'.repeat(64) },
      (input: ReturnType<typeof fixture>) => { input.outputs[2].label = 'default' },
    ]) {
      const input = fixture()
      change(input)
      expect(() => comparePackageOutputs(input)).toThrow()
    }
  })
  it('rejects incompatible package definitions before scoring', () => {
    const input = fixture()
    input.outputs[2].manifest.metrics[0].reference = { metric: 'hrv_rmssd', windowMs: 300000 }
    input.outputs[2].manifest.metrics[0].unit = 'ms'
    rebind(input.outputs[2])
    expect(() => comparePackageOutputs(input)).toThrow('Incompatible package metric')
  })
  it('does not score external RMSSD against the window IBI variability index', () => {
    const input = fixture()
    for (const output of input.outputs) {
      output.manifest.metrics[0].reference = { metric: 'window_ibi_variability_v1', windowMs: 300000 }
      output.manifest.metrics[0].unit = 'ms'
      rebind(output)
    }
    input.referenceImport.rows = input.referenceImport.rows.map(row => ({ ...row, metric: 'hrv_rmssd', unit: 'ms', windowMs: 300000 }))
    const report = comparePackageOutputs(input)
    expect(report.compatibilityExclusions).toEqual({ incompatible_metric_definition: 2 })
    expect(report.comparisons.every(row => row.commonSupport.candidate.status === 'incompatible' && row.commonSupport.candidate.metrics === null)).toBe(true)
  })
})
