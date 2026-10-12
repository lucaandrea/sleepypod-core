import { createHash } from 'node:crypto'
import { configHash } from '../algorithms/canonical'
import { REFERENCE_ADAPTER_VERSION, type ReferenceImportInput } from './contracts'
import { normalizeReferenceImport } from './normalize-core'
export { assertBoundedReferenceData } from './normalize-core'

export function previewReferenceImport(raw: ReferenceImportInput) {
  const result = normalizeReferenceImport(raw)
  const uploadHash = createHash('sha256').update(result.uploadJson).digest('hex')
  const contentHash = configHash({ adapterVersion: REFERENCE_ADAPTER_VERSION, uploadHash,
    measurementHashes: result.measurements.map(configHash), rejectionCounts: result.summary.rejectionCounts })
  return { measurements: result.measurements, summary: { ...result.summary, contentHash } }
}
