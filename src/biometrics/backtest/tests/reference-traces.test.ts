// @vitest-environment node
import { expect, it } from 'vitest'
import { pageReferenceTraces } from '../reference-trace-page'
import { evaluateBacktest } from '../evaluator'
import { backtestFixture } from './fixtures/backtest'
import { previewReferenceImport } from '../../references/normalize'
const request = { id: '11111111-1111-4111-8111-111111111111', expectedContentHash: 'a'.repeat(64), cohortId: 'night', metric: 'heart_rate' as const, limit: 1 }
function fixture() {
  const work = backtestFixture(), report = evaluateBacktest(work)
  return { report, dataset: { ...work.dataset, contentHash: report.datasetHash } }
}
it('pages frozen source revisions without annotations or submitted identity and preserves point times', () => {
  const { report, dataset } = fixture()
  const row = dataset.snapshot.references[0].measurements[1]
  row.original.annotation = 'private note'
  row.original.subjectId = 'private subject'
  dataset.snapshot.references.push({ ...dataset.snapshot.references[0], importId: 'second', revision: 2, source: 'another source' })
  const first = pageReferenceTraces(report, dataset, request)
  expect(first).toMatchObject({ totalItems: 2, side: 'left', provenance: 'frozen_dataset_reference', timestampBasis: 'reference_source_time', downsampled: false,
    nextCursor: { offset: 1, contentHash: request.expectedContentHash }, items: [{ source: 'fixture', importRevision: 1, temporalKind: 'point', value: 62, startMs: row.startMs }] })
  expect(JSON.stringify(first)).not.toContain('private')
  expect(first.items[0]).not.toHaveProperty('original')
  const second = pageReferenceTraces(report, dataset, { ...request, offset: first.nextCursor?.offset })
  expect(second.items[0].importId).toBe('second')
  expect(second.nextCursor).toBeNull()
})
it('keeps interval semantics and incompatible HRV visible without claiming a paired score', () => {
  const { report, dataset } = fixture()
  const start = dataset.snapshot.sessions[0].startMs
  dataset.snapshot.references[0].measurements.push(...previewReferenceImport({ side: 'left', source: 'watch', subjectId: 'A', rows: [
    { recordKey: 'hrv', metric: 'hrv_rmssd', value: 30, unit: 'ms', startMs: start, endMs: start + 300000, windowMs: 300000 },
  ] }).measurements)
  const page = pageReferenceTraces(report, dataset, { ...request, metric: 'window_ibi_variability_v1' })
  expect(page.items[0]).toMatchObject({ temporalKind: 'interval', metric: 'hrv_rmssd', compatibility: 'incompatible_metric_definition', endMs: start + 300000 })
  expect(page.items[0]).not.toHaveProperty('paired')
})
it('filters scoring windows and fails on stale identities or invalid pages', () => {
  const { report, dataset } = fixture()
  const row = dataset.snapshot.references[0].measurements[1]
  dataset.snapshot.references[0].measurements.push({ ...row, startMs: dataset.snapshot.sessions[0].endMs, endMs: dataset.snapshot.sessions[0].endMs })
  expect(pageReferenceTraces(report, dataset, request).totalItems).toBe(1)
  expect(() => pageReferenceTraces(report, { ...dataset, contentHash: 'other' }, request)).toThrow('hash changed')
  expect(() => pageReferenceTraces(report, dataset, { ...request, cohortId: 'absent' })).toThrow('not evaluated')
  expect(() => pageReferenceTraces(report, dataset, { ...request, offset: 2 })).toThrow('cursor')
})
