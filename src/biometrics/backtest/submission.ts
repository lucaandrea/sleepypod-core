import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { resolveStageView } from '../profiles/stage-view'
import { configHash } from '../algorithms/canonical'
import { defaultConfig, manifestHash } from '../algorithms/registry'
import { ProfileStore } from '../profiles/store'
import { ReferenceInputError } from '../references/time'
import { BacktestJobStore } from './jobs'

export const submitBacktestSchema = z.object({ experimentId: z.string().uuid(), candidateRevisionId: z.string().uuid(),
  expectedBindingGeneration: z.number().int().nonnegative(), split: z.enum(['tuning', 'validation', 'holdout']),
  idempotencyKey: z.string().min(1).max(200) }).strict()

/** Public callers select revisions, never supply trusted baseline snapshots. */
export function submitBacktest(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, evaluatorBuildHash: string, raw: z.input<typeof submitBacktestSchema>) {
  const input = submitBacktestSchema.parse(raw)
  const submissionHash = configHash(input)
  const existing = bioDb.select().from(bioSchema.biometricBacktestJobs).where(eq(bioSchema.biometricBacktestJobs.idempotencyKey, input.idempotencyKey)).get()
  if (existing) {
    const saved = z.object({ submissionHash: z.string().optional() }).parse(existing.input)
    if (saved.submissionHash !== submissionHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Backtest idempotency key belongs to a different submission')
    return existing
  }
  const experiment = bioDb.select().from(bioSchema.biometricExperiments).where(eq(bioSchema.biometricExperiments.id, input.experimentId)).get()
  if (!experiment) throw new ReferenceInputError('NOT_FOUND', 'Experiment not found')
  const snapshots = configDb.transaction(() => {
    const profiles = new ProfileStore(configDb)
    const binding = profiles.binding(experiment.side)
    if (binding.generation !== input.expectedBindingGeneration) throw new ReferenceInputError('REVISION_CONFLICT', 'Profile binding changed; inspect the current side before evaluating')
    const candidate = profiles.validateRevision(input.candidateRevisionId, experiment.side)
    // This is the actual retrospective view used by existing stage endpoints.
    // A desired-but-unacknowledged vitals profile is not a current baseline.
    const view = resolveStageView(configDb, bioDb, experiment.side)
    const current = { ...structuredClone(defaultConfig), sleep_stages: view.classifier }
    return [
      { label: 'default' as const, revisionId: null, manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig },
      { label: 'current' as const, revisionId: null, manifestHash, resolvedHash: configHash(current), resolved: current },
      { label: 'candidate' as const, revisionId: candidate.revision.id, manifestHash, resolvedHash: candidate.hash, resolved: candidate.resolved },
    ]
  })
  return new BacktestJobStore(bioDb).enqueue({ experimentId: input.experimentId, idempotencyKey: input.idempotencyKey,
    evaluatorBuildHash, submissionHash, split: input.split, configs: snapshots })
}
