import { z } from 'zod'
import { ReferenceInputError } from '../references/time'

const report = z.looseObject({ waveform: z.looseObject({ outputs: z.array(z.looseObject({ readings: z.unknown() })).max(180) }).optional(), version: z.enum(['processed-backtest-report-v1', 'waveform-backtest-report-v1']),
  nights: z.array(z.looseObject({ evaluations: z.array(z.looseObject({
    windows: z.array(z.looseObject({ blocks: z.unknown() })).max(60),
  })).max(3) })).max(60),
})

/** Project only after verifying the complete retained report. The content hash
 * still identifies that complete artifact; exact traces remain separately paged. */
export function summarizeBacktestResult<T extends { report: unknown, available: boolean }>(result: T | null) {
  if (result === null) return null
  let summary: unknown = null
  let waveformReport = false
  if (result.available) {
    const parsed = report.safeParse(result.report)
    if (!parsed.success) throw new ReferenceInputError('RESULT_CORRUPT', 'Report summary format is unavailable')
    waveformReport = parsed.data.version === 'waveform-backtest-report-v1'
    summary = { ...parsed.data, ...(parsed.data.waveform
      ? { waveform: { ...parsed.data.waveform, outputs: parsed.data.waveform.outputs.map((output) => {
          const metadata = { ...output }
          delete metadata.readings
          return metadata
        }) } }
      : {}), nights: parsed.data.nights.map(night => ({ ...night,
      evaluations: night.evaluations.map(evaluation => ({ ...evaluation, windows: evaluation.windows.map((window) => {
        const scores = { ...window }
        delete scores.blocks
        return scores
      }) })),
    })) }
    // Bound the response without truncating scores or silently dropping nights.
    if (new TextEncoder().encode(JSON.stringify(summary)).byteLength > 2 * 1024 * 1024) {
      throw new ReferenceInputError('RESOURCE_LIMIT', 'Report summary exceeds its 2 MiB transport limit')
    }
  }
  return { ...result, report: summary, projection: waveformReport ? 'scores_without_replay_trace_rows_v1' as const : 'scores_without_stage_trace_rows_v1' as const,
    contentHashScope: 'complete_retained_report' as const }
}
