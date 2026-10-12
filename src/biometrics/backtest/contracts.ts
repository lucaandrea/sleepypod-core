import { z } from 'zod'
import { normalizedMeasurementSchema } from '../references/contracts'
const key = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const experimentProtocolSchema = z.object({
  version: z.literal('descriptive-evaluation-v1'),
  mode: z.enum(['comparison', 'stage_replay']),
  // Explicit approximation, never represented as measured sensor calibration.
  assumedStageCalibrationQuality: z.number().min(0).max(1),
  pointToleranceMs: z.number().int().min(0).max(300000),
  clockOffsetMs: z.number().int().min(-3600000).max(3600000),
}).strict()
export const enqueueBacktestSchema = z.object({
  experimentId: z.string().uuid(), idempotencyKey: key, evaluatorBuildHash: hash,
  split: z.enum(['tuning', 'validation', 'holdout']),
  configs: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']), revisionId: z.string().uuid().nullable(),
    manifestHash: hash, resolvedHash: hash, resolved: z.unknown() }).strict()).min(1).max(3),
}).strict()

const vitalSchema = z.object({ id: z.number().int(), timestampMs: z.number().int(), heartRate: z.number().nullable(),
  hrv: z.number().nullable(), breathingRate: z.number().nullable(), processingRunId: z.string().nullable() })
const movementSchema = z.object({ id: z.number().int(), timestampMs: z.number().int(), totalMovement: z.number() })
export const datasetSnapshotSchema = z.object({
  version: z.literal('processed-dataset-v1'), side: z.enum(['left', 'right']), subjectId: z.string(),
  sessions: z.array(z.object({ id: z.number().int(), startMs: z.number().int(), endMs: z.number().int(),
    sleepDurationSeconds: z.number(), timesExitedBed: z.number(), presentIntervals: z.unknown(), notPresentIntervals: z.unknown(),
    vitals: z.array(vitalSchema), movement: z.array(movementSchema),
  })),
  references: z.array(z.object({ importId: z.string(), revision: z.number(), contentHash: z.string(), source: z.string(),
    timePolicy: z.unknown(), measurements: z.array(normalizedMeasurementSchema) })),
  processingRuns: z.array(z.object({ id: z.string(), side: z.string(), kind: z.string(), bundle: z.unknown(),
    configHash: z.string(), calibrationHash: z.string().nullable(), inputIdentity: z.unknown(), startedAtMs: z.number(), endedAtMs: z.number().nullable() })),
})
export type DatasetSnapshot = z.infer<typeof datasetSnapshotSchema>

