import { z } from 'zod'
import { traceRequestSchema } from './trace-contracts'
import { normalizedMeasurementSchema } from '../references/contracts'
import { referenceCompatibility } from '../references/alignment'
import { ReferenceInputError } from '../references/time'
import type { DatasetSnapshot } from './contracts'

export const referenceTraceRequestSchema = traceRequestSchema.omit({ configuration: true }).extend({
  cohortId: z.string().min(1).max(200), metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1', 'sleep_stages']),
})
const projected = normalizedMeasurementSchema.omit({ original: true }).strip().extend({
  importId: z.string(), importRevision: z.number().int(), importContentHash: z.string(), source: z.string(),
  compatibility: z.string().nullable(),
})
export const referenceTracePageSchema = z.object({ jobId: z.string().uuid(), contentHash: z.string(), datasetHash: z.string(),
  cohortId: z.string(), metric: referenceTraceRequestSchema.shape.metric, side: z.enum(['left', 'right']),
  provenance: z.literal('frozen_dataset_reference'), timestampBasis: z.literal('reference_source_time'),
  clockOffsetMs: z.number().int(), pointToleranceMs: z.number().int(),
  totalItems: z.number().int(), offset: z.number().int(), limit: z.number().int(), downsampled: z.literal(false),
  items: z.array(projected).max(500), nextCursor: z.object({ offset: z.number().int(), contentHash: z.string() }).nullable(),
})
const reportSchema = z.object({ version: z.enum(['processed-backtest-report-v1', 'waveform-backtest-report-v1']),
  datasetId: z.string().uuid(), datasetHash: z.string(),
  protocol: z.object({ clockOffsetMs: z.number().int(), pointToleranceMs: z.number().int() }),
  nights: z.array(z.object({ cohortId: z.string(), evaluations: z.array(z.object({
    windows: z.array(z.object({ startMs: z.number().int(), endMs: z.number().int() })).max(60),
  })).max(3) })).max(60),
})
export function referenceTraceIdentity(report: unknown) {
  const parsed = reportSchema.safeParse(report)
  if (!parsed.success) throw new ReferenceInputError('RESULT_CORRUPT', 'Reference trace report identity is unavailable')
  return parsed.data
}

/** Read only frozen imports, never the current reference library. Projection
 * excludes submitted payloads, annotations and subject identity. No score is
 * recomputed, and display records are not claims of independently paired data. */
export function pageReferenceTraces(report: unknown, dataset: { contentHash: string, snapshot: DatasetSnapshot }, raw: z.input<typeof referenceTraceRequestSchema>) {
  const input = referenceTraceRequestSchema.parse(raw), identity = referenceTraceIdentity(report)
  if (identity.datasetHash !== dataset.contentHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Reference dataset hash changed')
  const nights = identity.nights.filter(night => night.cohortId === input.cohortId)
  if (nights.length !== 1) throw new ReferenceInputError('NOT_FOUND', 'Requested reference cohort was not evaluated')
  const windows = nights[0].evaluations[0]?.windows
  if (!windows) throw new ReferenceInputError('RESULT_CORRUPT', 'Reference scoring windows unavailable')
  const items: z.infer<typeof referenceTracePageSchema>['items'] = []
  let totalItems = 0
  for (const reference of dataset.snapshot.references) {
    for (const row of reference.measurements) {
      const sameFamily = row.metric === input.metric || (input.metric === 'window_ibi_variability_v1' && row.metric.startsWith('hrv_'))
      if (!sameFamily || !windows.some(window => row.startMs >= window.startMs && (row.temporalKind === 'point' ? row.startMs < window.endMs : row.endMs <= window.endMs))) continue
      if (totalItems >= input.offset && items.length < input.limit) {
        items.push(projected.parse({ ...row, importId: reference.importId, importRevision: reference.revision, importContentHash: reference.contentHash, source: reference.source,
          compatibility: input.metric === 'sleep_stages'
            ? (row.scorable ? null : row.exclusions[0] ?? 'unscorable')
            : referenceCompatibility(input.metric, input.metric === 'window_ibi_variability_v1' ? 300000 : null, row) }))
      }
      totalItems++
    }
  }
  if (input.offset > totalItems) throw new ReferenceInputError('INVALID_CURSOR', 'Reference cursor exceeds the selected records')
  const next = input.offset + items.length
  return referenceTracePageSchema.parse({ jobId: input.id, contentHash: input.expectedContentHash, datasetHash: identity.datasetHash,
    cohortId: input.cohortId, metric: input.metric, side: dataset.snapshot.side, provenance: 'frozen_dataset_reference', timestampBasis: 'reference_source_time',
    ...identity.protocol, totalItems, offset: input.offset, limit: input.limit, items, downsampled: false,
    nextCursor: next < totalItems ? { offset: next, contentHash: input.expectedContentHash } : null })
}
