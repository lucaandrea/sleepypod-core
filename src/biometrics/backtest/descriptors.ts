import { z } from 'zod'
import type { biometricBacktestJobs } from '@/src/db/biometrics-schema'

export const jobDescriptorSchema = z.object({ id: z.string().uuid(), experimentId: z.string().uuid(),
  state: z.enum(['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed', 'interrupted']), attempt: z.number(),
  progress: z.object({ phase: z.string(), completedNights: z.number(), totalNights: z.number() }),
  cancellationRequestedAtMs: z.number().nullable(), error: z.string().nullable(), createdAtMs: z.number(), updatedAtMs: z.number(),
  datasetId: z.string().uuid(), datasetHash: z.string(), evaluatorBuildHash: z.string(), split: z.enum(['tuning', 'validation', 'holdout']),
  configurations: z.array(z.object({ label: z.string(), revisionId: z.string().uuid().nullable(), hash: z.string() })),
  evaluationScope: z.enum(['original_readings_comparison', 'stage_rules_on_original_readings', 'retained_waveform_replay']),
})
export function describeJob(row: typeof biometricBacktestJobs.$inferSelect) {
  const input = z.object({ datasetId: z.string(), datasetHash: z.string(), evaluatorBuildHash: z.string(), split: z.string(),
    protocol: z.object({ mode: z.enum(['comparison', 'stage_replay', 'signal_replay']) }),
    configs: z.array(z.object({ label: z.string(), revisionId: z.string().nullable(), resolvedHash: z.string() })),
  }).parse(row.input)
  return jobDescriptorSchema.parse({ ...row, datasetId: input.datasetId, datasetHash: input.datasetHash, evaluatorBuildHash: input.evaluatorBuildHash,
    split: input.split, configurations: input.configs.map(config => ({ label: config.label, revisionId: config.revisionId, hash: config.resolvedHash })),
    evaluationScope: input.protocol.mode === 'signal_replay' ? 'retained_waveform_replay' : input.protocol.mode === 'comparison' ? 'original_readings_comparison' : 'stage_rules_on_original_readings' })
}

export const resultDescriptorSchema = z.object({ jobId: z.string(), fencingToken: z.number(), report: z.unknown(),
  contentHash: z.string(), completedAtMs: z.number(), releasedAtMs: z.number().nullable(), available: z.boolean(), currentHoldoutUseCount: z.number() })
