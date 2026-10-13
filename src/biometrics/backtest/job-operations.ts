import { processGroupMemorySchema, type ProcessGroupMemory } from './process-group-memory-contract'
import { z } from 'zod'

/** Internal supervisor evidence, never accepted from experiment/RPC payloads. */
export const admissionReceiptSchema = z.object({
  allowed: z.boolean(),
  memory: processGroupMemorySchema.optional(),
  sample: z.object({ qualificationId: z.string().min(1).max(200), checkedAtMs: z.number().int().nonnegative(),
    ingestionAgeMs: z.number().int().nonnegative() }).strict().nullable(),
}).strict()
export const jobOperationsSchema = z.object({
  version: z.literal('backtest-job-operations-v1'), wallMs: z.number().finite().nonnegative(),
  scope: z.literal('admission_through_prepublication'),
  memory: processGroupMemorySchema.nullable().optional(),
  ingestion: z.object({ source: z.literal('supervisor_live_piezo_receipt_age'),
    checks: z.number().int().nonnegative(), samples: z.number().int().nonnegative(), allChecksMeasured: z.boolean(),
    qualificationId: z.string().nullable(), maximumObservedAgeMs: z.number().int().nonnegative().nullable(),
    maximumObservationGapMs: z.number().finite().nonnegative(), nominalIntervalMs: z.literal(5000), continuousMeasurement: z.literal(false),
  }).strict(),
}).strict()

export type AdmissionReceipt = z.infer<typeof admissionReceiptSchema>
export type HealthAdmission = () => Promise<AdmissionReceipt>

/** Bounded accumulation; no health frames or unbounded sample arrays. Clock
 * gaps are measured monotonically, independently of wall-clock adjustments. */
export function createJobOperations(now: () => number = () => performance.now()) {
  const start = now()
  let last = start, checks = 0, samples = 0, maximumGapMs = 0, maximumIngestionAgeMs = 0
  let memory: ProcessGroupMemory | null = null
  let qualificationId: string | null = null, consistent = true
  return {
    record(raw: unknown) {
      const at = now()
      maximumGapMs = Math.max(maximumGapMs, at - last)
      last = at
      checks++
      const receipt = admissionReceiptSchema.safeParse(raw)
      if (receipt.success && receipt.data.memory) memory = receipt.data.memory
      if (!receipt.success || !receipt.data.allowed || !receipt.data.sample) {
        consistent = false
        return
      }
      const sample = receipt.data.sample
      if (qualificationId !== null && qualificationId !== sample.qualificationId) consistent = false
      qualificationId ??= sample.qualificationId
      maximumIngestionAgeMs = Math.max(maximumIngestionAgeMs, sample.ingestionAgeMs)
      samples++
    },
    finish() {
      const end = now()
      return { version: 'backtest-job-operations-v1' as const, wallMs: Math.max(0, end - start),
        scope: 'admission_through_prepublication' as const, memory,
        ingestion: { source: 'supervisor_live_piezo_receipt_age' as const, checks, samples,
          allChecksMeasured: consistent && checks >= 2 && samples === checks,
          qualificationId: consistent ? qualificationId : null,
          maximumObservedAgeMs: samples > 0 ? maximumIngestionAgeMs : null,
          maximumObservationGapMs: Math.max(maximumGapMs, end - last),
          nominalIntervalMs: 5000,
          continuousMeasurement: false as const },
      }
    },
  }
}
