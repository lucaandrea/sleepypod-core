import { z } from 'zod'

export const vitalProvenanceSchema = z.object({
  interpretation: z.literal('original_observation'),
  status: z.enum(['recorded', 'legacy_unknown', 'unavailable']),
  processingRunId: z.string().nullable(),
  configurationHash: z.string().nullable(),
  hrvMetricId: z.string().nullable(),
})
export type VitalProvenance = z.infer<typeof vitalProvenanceSchema>

/** Describe recorded metadata only; today's manifest cannot identify old rows. */
export function vitalProvenance(row: {
  side: string
  processingRunId?: string | null
  recordedRunId?: string | null
  recordedSide?: string | null
  recordedKind?: string | null
  recordedConfigHash?: string | null
  recordedHrvMetricId?: unknown
}): VitalProvenance {
  const id = row.processingRunId ?? null
  const recorded = id !== null && row.recordedRunId === id && row.recordedSide === row.side
    && row.recordedKind === 'live' && /^[a-f0-9]{64}$/.test(row.recordedConfigHash ?? '')
  return {
    interpretation: 'original_observation',
    status: id === null ? 'legacy_unknown' : recorded ? 'recorded' : 'unavailable',
    processingRunId: id,
    configurationHash: recorded ? row.recordedConfigHash ?? null : null,
    hrvMetricId: recorded && typeof row.recordedHrvMetricId === 'string' && /^[a-z0-9_]{1,80}$/.test(row.recordedHrvMetricId)
      ? row.recordedHrvMetricId
      : null,
  }
}
