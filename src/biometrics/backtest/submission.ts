import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { resolveReplayBaseline } from '../profiles/replay-baseline'
import { experimentProtocolSchema } from './contracts'
import { workerBuildHash } from './child'
import { packagedCoordinatorPath, packagedWorkerPath } from './location'
import { waveformEvaluatorBuildIdentity } from './waveform-build'
import { podRawInspectionLocation } from './raw-inspection-child'
import { configHash } from '../algorithms/canonical'
import { defaultConfig, manifestHash } from '../algorithms/registry'
import { ProfileStore } from '../profiles/store'
import { ReferenceInputError } from '../references/time'
import { BacktestJobStore } from './jobs'

export const submitBacktestSchema = z.object({ experimentId: z.string().uuid(), candidateRevisionId: z.string().uuid(),
  expectedBindingGeneration: z.number().int().nonnegative(), split: z.enum(['tuning', 'validation', 'holdout']),
  idempotencyKey: z.string().min(1).max(200) }).strict()

export function retryBacktestSubmission(bioDb: BetterSQLite3Database<typeof bioSchema>, raw: z.input<typeof submitBacktestSchema>) {
  const input = submitBacktestSchema.parse(raw)
  const submissionHash = configHash(input)
  const existing = bioDb.select().from(bioSchema.biometricBacktestJobs).where(eq(bioSchema.biometricBacktestJobs.idempotencyKey, input.idempotencyKey)).get()
  if (existing) {
    const saved = z.object({ submissionHash: z.string().optional() }).parse(existing.input)
    if (saved.submissionHash !== submissionHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Backtest idempotency key belongs to a different submission')
    return existing
  }
  return null
}

const buildProbes = globalThis as typeof globalThis & {
  __waveformSubmissionBuild?: { key: string, promise: ReturnType<typeof waveformEvaluatorBuildIdentity> }
}
function sharedWaveformBuild(workerPath: string) {
  const coordinatorPath = packagedCoordinatorPath()
  const key = JSON.stringify([coordinatorPath, workerPath, podRawInspectionLocation.pythonPath, podRawInspectionLocation.modulesPath])
  if (buildProbes.__waveformSubmissionBuild?.key === key) return buildProbes.__waveformSubmissionBuild.promise
  const entry = { key, promise: waveformEvaluatorBuildIdentity(coordinatorPath, workerPath, podRawInspectionLocation) }
  buildProbes.__waveformSubmissionBuild = entry
  // Coalesce concurrent submissions, but never cache an identity after its probe.
  entry.promise = entry.promise.finally(() => {
    if (buildProbes.__waveformSubmissionBuild === entry) delete buildProbes.__waveformSubmissionBuild
  })
  return entry.promise
}

/** Resolve immutable build pins only after checking for an existing submission. */
export async function resolveSubmissionBuild(bioDb: BetterSQLite3Database<typeof bioSchema>, raw: z.input<typeof submitBacktestSchema>) {
  const input = submitBacktestSchema.parse(raw)
  const existing = retryBacktestSubmission(bioDb, input)
  if (existing) return { existing }
  const experiment = new BacktestJobStore(bioDb).getExperiment(input.experimentId)
  return resolveInstalledReplayBuild(experiment.protocol.mode)
}

/** Read installed artifacts; never accept evaluator identity from an RPC caller. */
export async function resolveInstalledReplayBuild(mode: z.infer<typeof experimentProtocolSchema>['mode']) {
  try {
    const workerPath = packagedWorkerPath()
    if (mode === 'signal_replay') {
      const build = await sharedWaveformBuild(workerPath)
      return { evaluatorBuildHash: build.hash, pythonBuildHash: build.python.hash }
    }
    return { evaluatorBuildHash: await workerBuildHash(workerPath) }
  }
  catch { throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Packaged replay build identity cannot be read') }
}

/** Public callers select revisions, never supply trusted baseline snapshots. */
export function submitBacktest(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, evaluatorBuildHash: string,
  raw: z.input<typeof submitBacktestSchema>, pythonBuildHash?: string) {
  const input = submitBacktestSchema.parse(raw)
  const submissionHash = configHash(input)
  const existing = retryBacktestSubmission(bioDb, input)
  if (existing) return existing
  const experiment = bioDb.select().from(bioSchema.biometricExperiments).where(eq(bioSchema.biometricExperiments.id, input.experimentId)).get()
  if (!experiment) throw new ReferenceInputError('NOT_FOUND', 'Experiment not found')
  const signalReplay = experimentProtocolSchema.parse(experiment.protocol).mode === 'signal_replay'
  if (signalReplay && !pythonBuildHash) throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Waveform submission requires the Python build identity')
  const snapshots = configDb.transaction(() => bioDb.transaction(() => {
    const profiles = new ProfileStore(configDb)
    const binding = profiles.binding(experiment.side)
    if (binding.generation !== input.expectedBindingGeneration) throw new ReferenceInputError('REVISION_CONFLICT', 'Profile binding changed; inspect the current side before evaluating')
    const candidate = profiles.validateRevision(input.candidateRevisionId, experiment.side)
    // This is the actual retrospective view used by existing stage endpoints.
    // A desired-but-unacknowledged vitals profile is not a current baseline.
    const currentBaseline = resolveReplayBaseline(configDb, bioDb, experiment.side)
    const otherBaseline = signalReplay ? resolveReplayBaseline(configDb, bioDb, experiment.side === 'left' ? 'right' : 'left') : null
    const current = currentBaseline.resolved
    return { waveform: otherBaseline && pythonBuildHash
      ? { pythonBuildHash,
          otherSide: { manifestHash, resolvedHash: otherBaseline.hash, resolved: otherBaseline.resolved },
          baselineProvenance: { current: currentBaseline.provenance, otherSide: otherBaseline.provenance } }
      : undefined, configs: [
      { label: 'default' as const, revisionId: null, manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig },
      { label: 'current' as const, revisionId: currentBaseline.revisionId, manifestHash, resolvedHash: configHash(current), resolved: current },
      { label: 'candidate' as const, revisionId: candidate.revision.id, manifestHash, resolvedHash: candidate.hash, resolved: candidate.resolved },
    ] }
  }))
  return new BacktestJobStore(bioDb).enqueue({ experimentId: input.experimentId, idempotencyKey: input.idempotencyKey,
    evaluatorBuildHash, submissionHash, split: input.split, configs: snapshots.configs, ...(snapshots.waveform ? { waveform: snapshots.waveform } : {}) })
}
