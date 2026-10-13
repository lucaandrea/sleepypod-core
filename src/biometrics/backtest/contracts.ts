import { stageObjectivePolicySchema } from './stage-objective'
import { z } from 'zod'
import { objectivePolicySchema, type ObjectivePolicy } from './objective-policy'
import { waveformDatasetInputsSchema } from './waveform-contracts'
import { nightBootstrapSchema } from './uncertainty-policy'
import { normalizedMeasurementSchema } from '../references/contracts'
const key = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const experimentProtocolSchema = z.object({
  version: z.literal('descriptive-evaluation-v1'),
  mode: z.enum(['comparison', 'stage_replay', 'signal_replay']),
  waveformStages: z.boolean().optional(),
  // Explicit approximation, never represented as measured sensor calibration.
  assumedStageCalibrationQuality: z.number().min(0).max(1),
  pointToleranceMs: z.number().int().min(0).max(300000),
  clockOffsetMs: z.number().int().min(-3600000).max(3600000),
  nightUncertainty: nightBootstrapSchema.optional(),
  objectivePolicy: objectivePolicySchema.optional(),
  objectivePolicies: z.array(objectivePolicySchema).min(1).max(3).optional(),
  stageObjectivePolicy: stageObjectivePolicySchema.optional(),
}).strict().refine(protocol => !(protocol.objectivePolicy && protocol.objectivePolicies), 'Use one numeric objective policy representation')
  .refine(protocol => new Set(numericObjectivePolicies(protocol).map(policy => policy.metric)).size === numericObjectivePolicies(protocol).length, 'Numeric objective metrics must be unique')
  .refine(protocol => !numericObjectivePolicies(protocol).length || protocol.mode === 'signal_replay', 'Numeric objectives require waveform replay')
  .refine(protocol => !protocol.stageObjectivePolicy || protocol.mode === 'stage_replay' || (protocol.mode === 'signal_replay' && protocol.waveformStages === true), 'Stage objectives require stage replay')
/** Preserve old protocol hashes: normalize at consumption, never mutate snapshots. */
export function numericObjectivePolicies(protocol: { objectivePolicy?: ObjectivePolicy, objectivePolicies?: ObjectivePolicy[] }): ObjectivePolicy[] {
  return protocol.objectivePolicies ?? (protocol.objectivePolicy ? [protocol.objectivePolicy] : [])
}
export const replayBaselineProvenanceSchema = z.object({ source: z.enum(['acknowledged_runtime', 'unacknowledged_defaults']),
  generation: z.number().int().nonnegative().nullable(), effectiveSampleTimeMs: z.number().int().nonnegative().nullable(), warning: z.string().max(1000).nullable() }).strict()
export const enqueueBacktestSchema = z.object({
  experimentId: z.string().uuid(), idempotencyKey: key, evaluatorBuildHash: hash, submissionHash: hash.optional(),
  waveform: z.object({ pythonBuildHash: hash, baselineProvenance: z.object({ current: replayBaselineProvenanceSchema, otherSide: replayBaselineProvenanceSchema }).strict().optional(), otherSide: z.object({ manifestHash: hash, resolvedHash: hash, resolved: z.unknown() }).strict() }).strict().optional(),
  split: z.enum(['tuning', 'validation', 'holdout']),
  configs: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']), revisionId: z.string().uuid().nullable(),
    manifestHash: hash, resolvedHash: hash, resolved: z.unknown() }).strict()).min(1).max(3),
}).strict()

export const backtestJobSnapshotSchema = enqueueBacktestSchema.extend({ version: z.literal('backtest-job-v1'), datasetId: z.string().uuid(),
  datasetHash: z.string(), protocol: experimentProtocolSchema, protocolHash: z.string(), holdoutUse: z.number().int().nonnegative(),
  evidence: z.enum(['descriptive_only', 'reused_holdout_is_validation']),
})

const vitalSchema = z.object({ id: z.number().int(), timestampMs: z.number().int(), heartRate: z.number().nullable(),
  hrv: z.number().nullable(), breathingRate: z.number().nullable(), processingRunId: z.string().nullable() })
const movementSchema = z.object({ id: z.number().int(), timestampMs: z.number().int(), totalMovement: z.number() })
const processedDatasetSnapshotSchema = z.object({
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
export const datasetSnapshotSchema = z.discriminatedUnion('version', [
  processedDatasetSnapshotSchema,
  processedDatasetSnapshotSchema.extend({ version: z.literal('waveform-dataset-v1'), waveformInputs: waveformDatasetInputsSchema }),
])
export type DatasetSnapshot = z.infer<typeof datasetSnapshotSchema>

export const coverageSchema = z.object({ count: z.number(), duplicateTimestamps: z.number(), firstMs: z.number().nullable(), lastMs: z.number().nullable(),
  expectedCadenceMs: z.number(), gaps: z.array(z.object({ startMs: z.number(), endMs: z.number() })), gapDurationMs: z.number(),
  interpretation: z.literal('cadence_availability_not_measured_support') })
export const datasetManifestSchema = z.object({
  version: z.enum(['processed-dataset-manifest-v1', 'waveform-dataset-manifest-v1']),
  parentDataset: z.object({ id: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  splitProtocol: z.object({ version: z.literal('chronological-whole-night-v1'), timezone: z.string(),
    timezoneRuntime: z.object({ icu: z.string(), tz: z.string() }), grouping: z.literal('local_noon_connected_sessions'),
    assignments: z.array(z.object({ cohortId: z.string(), nightLabels: z.array(z.string()), sessionIds: z.array(z.number()),
      startMs: z.number(), endMs: z.number(), split: z.enum(['tuning', 'validation', 'holdout']) })),
    evidence: z.enum(['partitioned_not_validated', 'descriptive_only']), limitations: z.array(z.string()),
  }),
  coverage: z.array(z.object({ sessionId: z.number(), vitals: coverageSchema, movement: coverageSchema })),
  capabilities: z.object({ comparison: z.boolean(), stageReplay: z.boolean(), signalReplay: z.boolean() }), limitations: z.array(z.string()),
})
export const datasetDescriptorSchema = z.object({ id: z.string().uuid(), side: z.enum(['left', 'right']), subjectId: z.string(),
  contentHash: z.string(), manifest: datasetManifestSchema, byteLength: z.number(), createdAtMs: z.number(), releasedAtMs: z.number().nullable(), available: z.boolean() })

export const createDatasetSchema = z.object({
  side: z.enum(['left', 'right']), subjectId: z.string().min(1).max(200),
  sessionIds: z.array(z.number().int().positive()).min(1).max(60),
  referenceImportIds: z.array(z.string().uuid()).max(20),
  timezone: z.string().min(1).max(100),
  idempotencyKey: z.string().min(1).max(200),
}).strict()
