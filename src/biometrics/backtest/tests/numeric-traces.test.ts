// @vitest-environment node
import { expect, it } from 'vitest'
import { pageNumericTraces } from '../numeric-trace-page'
const hash = 'b'.repeat(64)
const request = { id: '11111111-1111-4111-8111-111111111111', expectedContentHash: 'a'.repeat(64), configuration: 'candidate' as const, limit: 2 }
function fixture() {
  const reading = { side: 'left', sourceSide: 'right', configHash: hash, timestampMs: 1000, heartRate: 60, breathingRate: null, hrvIndex: null,
    hrvMetric: 'window_ibi_variability_v1', qualityScore: 0, flags: null, limitations: ['unknown_context'], hrRaw: 65 }
  return { version: 'waveform-backtest-report-v1', side: 'left', protocol: { mode: 'signal_replay', clockOffsetMs: 60000 },
    nights: [{ cohortId: 'one', evaluations: ['default', 'candidate'].map(label => ({ label, configHash: hash, revisionId: null, windows: [{ startMs: 1000, endMs: 5000 }] })) }],
    waveform: { outputs: [{ cohortId: 'one', configHash: hash, readings: [
      { ...reading, timestampMs: 999 }, reading, { ...reading, side: 'right', heartRate: 99 },
      { ...reading, timestampMs: 2000, heartRate: null }, { ...reading, timestampMs: 4000 }, { ...reading, timestampMs: 5000 },
    ] }] } }
}
it('pages exact dataset-side readings without offset, downsampling, opposite-side values or private extra fields', () => {
  const report = fixture(), before = structuredClone(report)
  const first = pageNumericTraces(report, request)
  expect(first).toMatchObject({ totalItems: 3, side: 'left', downsampled: false, clockOffsetMs: 60000,
    provenance: 'retained_waveform_recomputation', nextCursor: { offset: 2, contentHash: request.expectedContentHash } })
  expect(first.items.map(row => row.timestampMs)).toEqual([1000, 2000])
  expect(first.items[1].heartRate).toBeNull()
  expect(first.items[0]).not.toHaveProperty('hrRaw')
  expect(first.items[0].sourceSide).toBe('right')
  const last = pageNumericTraces(report, { ...request, offset: first.nextCursor?.offset })
  expect(last.items.map(row => row.timestampMs)).toEqual([4000])
  expect(last.nextCursor).toBeNull()
  expect(pageNumericTraces(report, { ...request, configuration: 'default' }).items).toEqual(first.items)
  expect(report).toEqual(before)
})
it('rejects missing provenance, ambiguous output identity and invalid selections', () => {
  expect(() => pageNumericTraces({ ...fixture(), side: undefined }, request)).toThrow('provenance')
  const duplicate = fixture()
  duplicate.waveform.outputs.push(duplicate.waveform.outputs[0])
  expect(() => pageNumericTraces(duplicate, request)).toThrow('ambiguous')
  const mismatch = fixture()
  mismatch.waveform.outputs[0].readings[1].configHash = 'c'.repeat(64)
  expect(() => pageNumericTraces(mismatch, request)).toThrow('configuration mismatch')
  expect(() => pageNumericTraces(fixture(), { ...request, cohortId: 'absent' })).toThrow('not evaluated')
  expect(() => pageNumericTraces(fixture(), { ...request, configuration: 'current' })).toThrow('not evaluated')
  expect(() => pageNumericTraces(fixture(), { ...request, offset: 4 })).toThrow('cursor')
  expect(() => pageNumericTraces(fixture(), { ...request, limit: 501 })).toThrow()
})
