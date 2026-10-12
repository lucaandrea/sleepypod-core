import { z } from 'zod'
import { ReferenceInputError } from '../references/time'
import { traceRequestSchema, tracePageSchema } from './trace-contracts'

const reportSchema = z.object({ version: z.enum(['processed-backtest-report-v1', 'waveform-backtest-report-v1']),
  protocol: z.object({ mode: z.enum(['comparison', 'stage_replay', 'signal_replay']), waveformStages: z.boolean().optional(), clockOffsetMs: z.number().int() }),
  nights: z.array(z.object({ cohortId: z.string(), evaluations: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']),
    configHash: z.string(), revisionId: z.string().uuid().nullable(), windows: z.array(z.object({ startMs: z.number().int(), endMs: z.number().int(),
      blocks: z.array(z.object({ start: z.number().int(), end: z.number().int(), stage: z.enum(['wake', 'light', 'deep', 'rem']) })),
    })),
  })).max(3) })).max(60),
})

/** Selection changes only returned detail, never the retained evaluation or
 * its scoring. Offset cursors are pinned to an immutable verified report hash. */
export function pageStageTraces(report: unknown, raw: z.input<typeof traceRequestSchema>) {
  const input = traceRequestSchema.parse(raw)
  const parsed = reportSchema.safeParse(report)
  if (!parsed.success) throw new ReferenceInputError('RESULT_CORRUPT', 'Report trace format is unavailable')
  const data = parsed.data
  if (data.protocol.mode !== 'stage_replay' && !(data.protocol.mode === 'signal_replay' && data.protocol.waveformStages)) throw new ReferenceInputError('INCOMPATIBLE_METRIC', 'This comparison did not produce stage replay traces')
  const nights = input.cohortId === undefined ? data.nights : data.nights.filter(night => night.cohortId === input.cohortId)
  if (!nights.length || !nights.some(night => night.evaluations.some(evaluation => evaluation.label === input.configuration))) {
    throw new ReferenceInputError('NOT_FOUND', 'Requested cohort or configuration was not evaluated')
  }
  const items: z.infer<typeof tracePageSchema>['items'] = []
  let totalItems = 0
  for (const night of nights) {
    for (const evaluation of night.evaluations.filter(row => row.label === input.configuration)) {
      for (const window of evaluation.windows) {
        for (const block of window.blocks) {
          if (totalItems >= input.offset && items.length < input.limit) items.push({ cohortId: night.cohortId, configurationHash: evaluation.configHash,
            revisionId: evaluation.revisionId, windowStartMs: window.startMs, windowEndMs: window.endMs,
            startMs: block.start, endMs: block.end, stage: block.stage })
          totalItems++
        }
      }
    }
  }
  if (input.offset > totalItems) throw new ReferenceInputError('INVALID_CURSOR', 'Trace cursor exceeds the selected report')
  const next = input.offset + items.length
  return tracePageSchema.parse({ jobId: input.id, contentHash: input.expectedContentHash, configuration: input.configuration,
    provenance: 'versioned_stage_replay', timestampBasis: 'original_trace_before_reference_clock_offset', clockOffsetMs: data.protocol.clockOffsetMs,
    items, totalItems, offset: input.offset, limit: input.limit, downsampled: false,
    nextCursor: next < totalItems ? { offset: next, contentHash: input.expectedContentHash } : null })
}

