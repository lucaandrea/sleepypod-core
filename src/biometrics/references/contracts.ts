import { z } from 'zod'
import { sideSchema } from '@/src/server/validation-schemas'

export const REFERENCE_ADAPTER_VERSION = 'normalized-reference-v1'
export const REFERENCE_LIMITS = { bytes: 2 * 1024 * 1024, rows: 2000, depth: 12, nodes: 100000, rejectionExamples: 25 } as const
export const referenceMetricSchema = z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1', 'hrv_rmssd', 'hrv_sdnn', 'hrv_unknown', 'sleep_stages'])
export type ReferenceMetric = z.infer<typeof referenceMetricSchema>
export const referenceStageSchema = z.enum(['wake', 'light', 'deep', 'rem', 'asleep', 'in_bed', 'unknown'])
export const timestampMsSchema = z.number().int().min(1_000_000_000_000).max(4_102_444_800_000)
export const timePolicySchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  disambiguation: z.enum(['reject', 'earlier', 'later']).default('reject'),
}).strict()

export const referenceRowSchema = z.object({
  recordKey: z.string().min(1).max(200),
  subjectId: z.string().min(1).max(200).optional(),
  metric: referenceMetricSchema,
  value: z.union([z.number().finite(), referenceStageSchema]),
  unit: z.string().min(1).max(40),
  timestampMs: timestampMsSchema.optional(),
  startMs: timestampMsSchema.optional(),
  endMs: timestampMsSchema.optional(),
  // Offset-bearing ISO, or an explicitly resolved local time under timePolicy.
  timestamp: z.string().max(80).optional(),
  start: z.string().max(80).optional(),
  end: z.string().max(80).optional(),
  aggregation: z.enum(['instant', 'mean', 'median', 'window_index', 'stage']).optional(),
  windowMs: z.number().int().min(1).max(24 * 60 * 60 * 1000).optional(),
  quality: z.number().finite().min(0).max(1).optional(),
  annotation: z.string().max(1000).optional(),
}).strict()
export type ReferenceRow = z.infer<typeof referenceRowSchema>

export const referenceImportSchema = z.object({
  side: sideSchema,
  subjectId: z.string().min(1).max(200),
  source: z.string().min(1).max(120),
  timePolicy: timePolicySchema.default({ disambiguation: 'reject' }),
  rows: z.array(z.unknown()).min(1).max(REFERENCE_LIMITS.rows),
}).strict()
export type ReferenceImportInput = z.input<typeof referenceImportSchema>

export const normalizedMeasurementSchema = z.object({
  recordKey: z.string(),
  metric: referenceMetricSchema,
  value: z.number().nullable(),
  stage: referenceStageSchema.nullable(),
  unit: z.string(),
  startMs: timestampMsSchema,
  endMs: timestampMsSchema,
  temporalKind: z.enum(['point', 'interval']),
  aggregation: z.enum(['instant', 'mean', 'median', 'window_index', 'stage']),
  windowMs: z.number().nullable(),
  quality: z.number().nullable(),
  scorable: z.boolean(),
  exclusions: z.array(z.string()),
  // Retain the submitted units, values, source times and annotations as data.
  original: referenceRowSchema,
}).strict()
export type NormalizedMeasurement = z.infer<typeof normalizedMeasurementSchema>

export const previewSummarySchema = z.object({
  contentHash: z.string(),
  adapterVersion: z.string(),
  side: sideSchema,
  subjectId: z.string(),
  source: z.string(),
  timePolicy: timePolicySchema,
  received: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  duplicates: z.number(),
  unscorable: z.number(),
  conflicts: z.number(),
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  metrics: z.array(referenceMetricSchema),
  rejectionCounts: z.record(z.string(), z.number()),
  rejectionExamples: z.array(z.object({ row: z.number(), code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
})
export type PreviewSummary = z.infer<typeof previewSummarySchema>

export const referenceImportDescriptorSchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  revision: z.number().int(),
  supersedesImportId: z.string().uuid().nullable(),
  summary: previewSummarySchema,
  createdAtMs: z.number(),
  deletedAtMs: z.number().nullable(),
  available: z.boolean(),
})
