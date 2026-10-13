// @vitest-environment node
import { expect, it } from 'vitest'
import { datasetHandlers as handlers, demoDatasetSnapshot, demoDatasetBusy } from '../handlers/biometric-datasets'
import { referenceHandlers } from '../handlers/biometric-references'
import { datasetDescriptorSchema } from '@/src/biometrics/backtest/contracts'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}
it('pages eligible synthetic nights and freezes exact retained inputs with whole-night splits', async () => {
  const first = await required(handlers.listSessions)({ side: 'left' })
  expect(first.items).toHaveLength(20)
  expect(first.nextCursor).not.toBeNull()
  const second = await required(handlers.listSessions)({ side: 'left', beforeId: first.nextCursor?.id, beforeStartMs: first.nextCursor?.startMs })
  expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(first.items.length + second.items.length)
  const capability = await required(handlers.getSessionCapabilities)({ side: 'left', id: first.items[0].id })
  expect(capability.stageReplay).toBe(true)
  expect(capability.signalReplay).toBe(false)
  expect(capability.processed.vitals.expectedCadenceMs).toBe(120000)
  const request = { side: 'left' as const, subjectId: 'demo-sleeper', sessionIds: first.items.slice(0, 3).map(row => row.id), referenceImportIds: [], idempotencyKey: 'frozen-demo-test' }
  const results = await Promise.all([0, 1].map(() => required(handlers.createDataset)(request)))
  const descriptor = datasetDescriptorSchema.parse(results[0])
  expect(results[1]).toEqual(descriptor)
  expect(descriptor.manifest.splitProtocol.assignments.map(row => row.split)).toEqual(['tuning', 'validation', 'holdout'])
  const captured = demoDatasetSnapshot(descriptor.id)
  expect(descriptor.contentHash).toBe(dataHash({ manifest: descriptor.manifest, snapshot: captured.snapshot }))
  captured.snapshot.sessions[0].vitals.length = 0
  expect(demoDatasetSnapshot(descriptor.id).snapshot.sessions[0].vitals.length).toBeGreaterThan(0)
  await expect(required(handlers.createDataset)({ ...request, subjectId: 'changed' })).rejects.toThrow('REVISION_CONFLICT')
  await expect(required(handlers.createDataset)({ ...request, side: 'right', idempotencyKey: 'wrong-side-demo' })).rejects.toThrow('NOT_FOUND')
})
it('retains reference copies after deletion and honors every active job before release', async () => {
  const sessions = await required(handlers.listSessions)({ side: 'right' })
  const batch = { side: 'right' as const, subjectId: 'demo-sleeper', source: 'dataset-test', rows: [{ recordKey: 'hr', metric: 'heart_rate', timestampMs: sessions.items[0].startMs, value: 60, unit: 'bpm' }] }
  const preview = await required(referenceHandlers.previewImport)(batch)
  const reference = await required(referenceHandlers.commitImport)({ import: batch, previewHash: preview.contentHash })
  const dataset = await required(handlers.createDataset)({ side: 'right', subjectId: 'demo-sleeper', sessionIds: [sessions.items[0].id], referenceImportIds: [reference.id], idempotencyKey: 'reference-copy-demo' })
  await required(referenceHandlers.deleteImport)({ id: reference.id })
  expect(demoDatasetSnapshot(dataset.id).snapshot.references[0].measurements[0].value).toBe(60)
  demoDatasetBusy(dataset.id, 'one', true)
  demoDatasetBusy(dataset.id, 'two', true)
  demoDatasetBusy(dataset.id, 'one', false)
  expect(() => required(handlers.releaseDataset)({ id: dataset.id })).toThrow('active demo job')
  demoDatasetBusy(dataset.id, 'two', false)
  const released = await required(handlers.releaseDataset)({ id: dataset.id })
  expect(released).toMatchObject({ available: false, byteLength: 0, contentHash: dataset.contentHash })
  expect(() => demoDatasetSnapshot(dataset.id)).toThrow('DATASET_RELEASED')
  expect(await required(handlers.releaseDataset)({ id: dataset.id })).toEqual(released)
})

it('does not invent raw archives or resource qualification for demo waveform controls', async () => {
  expect(await required(handlers.getReplayAdmission)({})).toEqual({ configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] })
  expect(await required(handlers.listRawSources)({ startMs: 0, endMs: 1000 })).toEqual({ items: [], nextCursor: null })
  expect(await required(handlers.inspectRawSource)({ afterName: 'a.RAW.gz' })).toEqual({ status: 'deferred', nextCursor: 'a.RAW.gz' })
  expect(await required(handlers.createWaveformDataset)({ parentDatasetId: '00000000-0000-4000-8000-000000000001', expectedContentHash: 'a'.repeat(64),
    cohorts: [{ cohortId: 'night', sourceIds: ['b'.repeat(64)] }], idempotencyKey: 'demo-raw' })).toEqual({ status: 'deferred' })
})
