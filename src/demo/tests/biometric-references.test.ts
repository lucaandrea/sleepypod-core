// @vitest-environment node
import { expect, it } from 'vitest'
import { referenceHandlers as handlers } from '../handlers/biometric-references'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
import type { ReferenceImportInput } from '@/src/biometrics/references/contracts'
function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}
const row = { recordKey: 'hr', metric: 'heart_rate', timestampMs: Date.UTC(2026, 9, 10, 23), value: 1, unit: 'Hz' }
const input: ReferenceImportInput = { side: 'left', subjectId: 'demo-sleeper', source: 'synthetic-export', rows: [row, { ...row, recordKey: 'bad', unit: 'wrong' }] }
it('uses the production preview and hashes, and requires exact bytes plus explicit partial-import acknowledgement', async () => {
  const preview = await required(handlers.previewImport)(input)
  expect(preview).toEqual(previewReferenceImport(input).summary)
  // Captured from the pre-extraction production normalizer.
  expect(preview.contentHash).toBe('667f756b3e46077ba321a8621fc887af0258edf429aded801203c78a0f8e3f79')
  const commit = required(handlers.commitImport)
  await expect(commit({ import: input, previewHash: preview.contentHash })).rejects.toThrow('REJECTED_ROWS')
  await expect(commit({ import: { ...input, source: 'changed' }, previewHash: preview.contentHash, acceptRejectedRows: true })).rejects.toThrow('STALE_PREVIEW')
  const results = await Promise.all([0, 1].map(() => commit({ import: input, previewHash: preview.contentHash, acceptRejectedRows: true })))
  expect(new Set(results.map(result => result.id)).size).toBe(1)
  expect(results.map(result => result.alreadyImported).sort()).toEqual([false, true])
  const measurements = await required(handlers.getImportMeasurements)({ id: results[0].id, limit: 1 })
  expect(measurements.items[0]).toMatchObject({ value: 60, unit: 'bpm', original: row })
  expect((await required(handlers.listImports)({ side: 'right' })).items).toEqual([])
})
it('preserves old measurements on correction, rejects stale correction parents and retains deletion tombstones', async () => {
  const batch: ReferenceImportInput = { ...input, source: 'correction-test', rows: [row, { ...row, recordKey: 'second', timestampMs: row.timestampMs + 60000 }] }
  const preview = required(handlers.previewImport), commit = required(handlers.commitImport)
  const initial = await commit({ import: batch, previewHash: (await preview(batch)).contentHash })
  const corrected = { ...batch, rows: [{ ...row, value: 1.2 }] }
  const correction = await commit({ import: corrected, previewHash: (await preview(corrected)).contentHash, supersedesImportId: initial.id })
  expect(correction.familyId).toBe(initial.familyId)
  expect(correction.revision).toBe(2)
  expect((await required(handlers.getImportMeasurements)({ id: initial.id })).items).toHaveLength(2)
  await expect(commit({ import: { ...corrected, rows: [row] }, previewHash: (await preview({ ...corrected, rows: [row] })).contentHash, supersedesImportId: initial.id })).rejects.toThrow('REVISION_CONFLICT')
  const firstPage = await required(handlers.getImportMeasurements)({ id: initial.id, limit: 1 })
  const secondPage = await required(handlers.getImportMeasurements)({ id: initial.id, afterId: firstPage.nextCursor ?? 0, limit: 1 })
  expect(secondPage.items[0].recordKey).toBe('second')
  await required(handlers.deleteImport)({ id: initial.id })
  expect((await required(handlers.getImport)({ id: initial.id })).available).toBe(false)
  expect(() => required(handlers.getImportMeasurements)({ id: initial.id })).toThrow('REFERENCE_DELETED')
  expect((await required(handlers.getImportMeasurements)({ id: correction.id })).items[0].value).toBe(72)
})
