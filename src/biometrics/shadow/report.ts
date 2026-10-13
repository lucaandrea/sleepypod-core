import { dataHash } from '../algorithms/canonical'
import { referenceImportSchema } from '../references/contracts'
import { previewReferenceImport } from '../references/normalize'
import type { ShadowStore } from './store'
import { summarizeShadowSnapshot } from './report-core'

/** Complete, integrity-checked storage snapshot; never canonical vitals. */
export function reportShadowRun(store: ShadowStore, runId: string, limits: Parameters<ShadowStore['snapshot']>[1], rawReference?: unknown) {
  const snapshot = store.snapshot(runId, limits), { plan } = snapshot.run
  const referenceInput = rawReference === undefined ? null : referenceImportSchema.parse(rawReference)
  if (referenceInput && (referenceInput.subjectId !== plan.subjectId || referenceInput.side !== plan.side)) throw new Error('Shadow reference subject or side mismatch')
  const reference = referenceInput ? previewReferenceImport(referenceInput) : null
  const report = summarizeShadowSnapshot(snapshot, reference, plan.execution ? dataHash(plan.execution) : null)
  return { ...report, reportHash: dataHash(report) }
}
