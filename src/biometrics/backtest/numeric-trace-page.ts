import { z } from 'zod'
import { ReferenceInputError } from '../references/time'
import { traceRequestSchema } from './trace-contracts'
import { waveformReadingSchema } from './waveform-output'

const reading = waveformReadingSchema.pick({ timestampMs: true, heartRate: true, breathingRate: true, hrvIndex: true,
  hrvMetric: true, qualityScore: true, flags: true, sourceSide: true, configHash: true, side: true, limitations: true }).strip()
export const numericTracePageSchema = z.object({ jobId: z.string().uuid(), contentHash: z.string(),
  configuration: z.enum(['default', 'current', 'candidate']), side: z.enum(['left', 'right']),
  provenance: z.literal('retained_waveform_recomputation'), timestampBasis: z.literal('original_trace_before_reference_clock_offset'), clockOffsetMs: z.number(),
  totalItems: z.number().int(), offset: z.number().int(), limit: z.number().int(), downsampled: z.literal(false),
  items: z.array(reading.extend({ cohortId: z.string(), revisionId: z.string().uuid().nullable() })).max(500),
  nextCursor: z.object({ offset: z.number().int(), contentHash: z.string() }).nullable(),
})
const reportSchema = z.object({ version: z.literal('waveform-backtest-report-v1'), side: z.enum(['left', 'right']),
  protocol: z.object({ mode: z.literal('signal_replay'), clockOffsetMs: z.number().int() }),
  waveform: z.object({ outputs: z.array(z.object({ cohortId: z.string(), configHash: z.string(), readings: z.array(reading).max(20000) })).max(180) }),
  nights: z.array(z.object({ cohortId: z.string(), evaluations: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']),
    configHash: z.string(), revisionId: z.string().uuid().nullable(),
    windows: z.array(z.object({ startMs: z.number().int(), endMs: z.number().int() })).max(60),
  })).max(3) })).max(60),
}).refine(report => report.waveform.outputs.reduce((sum, output) => sum + output.readings.length, 0) <= 20000
  && new Set(report.nights.map(night => night.cohortId)).size === report.nights.length)

/** Exact retained numeric rows for the dataset side only. Cross-side routing
 * provenance is retained, but opposite-side observations are never returned. */
export function pageNumericTraces(report: unknown, raw: z.input<typeof traceRequestSchema>) {
  const input = traceRequestSchema.parse(raw)
  const parsed = reportSchema.safeParse(report)
  if (!parsed.success) throw new ReferenceInputError('RESULT_CORRUPT', 'Numeric trace format or side provenance is unavailable')
  const data = parsed.data
  const nights = data.nights.filter(night => input.cohortId === undefined || night.cohortId === input.cohortId)
  const items: z.infer<typeof numericTracePageSchema>['items'] = []
  let totalItems = 0, selections = 0
  for (const night of nights) {
    const evaluations = night.evaluations.filter(row => row.label === input.configuration)
    if (evaluations.length > 1) throw new ReferenceInputError('RESULT_CORRUPT', 'Duplicate numeric configuration')
    for (const evaluation of evaluations) {
      selections++
      const outputs = data.waveform.outputs.filter(output => output.cohortId === night.cohortId && output.configHash === evaluation.configHash)
      if (outputs.length !== 1) throw new ReferenceInputError('RESULT_CORRUPT', 'Numeric trace output identity is ambiguous or missing')
      for (const row of outputs[0].readings) {
        if (row.configHash !== evaluation.configHash && row.side === data.side) throw new ReferenceInputError('RESULT_CORRUPT', 'Numeric reading configuration mismatch')
        if (row.side !== data.side || !evaluation.windows.some(window => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)) continue
        if (totalItems >= input.offset && items.length < input.limit) items.push({ ...row, cohortId: night.cohortId, revisionId: evaluation.revisionId })
        totalItems++
      }
    }
  }
  if (!selections) throw new ReferenceInputError('NOT_FOUND', 'Requested cohort or configuration was not evaluated')
  if (input.offset > totalItems) throw new ReferenceInputError('INVALID_CURSOR', 'Trace cursor exceeds the selected report')
  const next = input.offset + items.length
  return numericTracePageSchema.parse({ jobId: input.id, contentHash: input.expectedContentHash, configuration: input.configuration, side: data.side,
    provenance: 'retained_waveform_recomputation', timestampBasis: 'original_trace_before_reference_clock_offset', clockOffsetMs: data.protocol.clockOffsetMs,
    totalItems, offset: input.offset, limit: input.limit, items, downsampled: false,
    nextCursor: next < totalItems ? { offset: next, contentHash: input.expectedContentHash } : null })
}
