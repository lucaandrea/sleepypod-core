import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { configHash } from '../algorithms/canonical'
import { BacktestJobStore } from '../backtest/jobs'
import { DatasetStore } from '../backtest/datasets'
import { backtestJobSnapshotSchema, datasetManifestSchema } from '../backtest/contracts'
import { ReferenceInputError } from '../references/time'
import { verifyEvaluationAssessments, type DesignatedEvaluationPolicies } from './evaluation-assessment'
import { ProfileStore } from './store'
import { resolveReplayBaseline } from './replay-baseline'

type ConfigDB = BetterSQLite3Database<typeof configSchema>
type BioDB = BetterSQLite3Database<typeof bioSchema>
export interface EvaluationSelection {
  side: 'left' | 'right'
  revisionId: string
  expectedResolvedHash: string
  expectedGeneration: number
  evaluationId: string
  expectedReportHash: string
}
/** Supplied by the installed build, never an RPC request. */
export interface PromotionBuild {
  evaluatorBuildHash: string
  pythonBuildHash?: string
  designations: DesignatedEvaluationPolicies
}

function baseline(configDb: ConfigDB, bioDb: BioDB, side: 'left' | 'right') {
  const desired = new ProfileStore(configDb).effective(side)
  const actual = resolveReplayBaseline(configDb, bioDb, side)
  if (desired.warning || (actual.provenance.warning && desired.binding.generation > 0)
    || desired.hash !== actual.hash || (desired.binding.generation > 0 && actual.provenance.generation !== desired.binding.generation)) {
    throw new ReferenceInputError('BASELINE_PENDING', 'Resolve pending or incompatible runtime configuration before validated activation')
  }
  return actual
}

/** Full retained artifact parsing/hashing runs before the short commit locks.
 * The returned guard must run while both databases are held by the caller. */
export function prepareVerifiedEvaluation(configDb: ConfigDB, bioDb: BioDB, input: EvaluationSelection, build: PromotionBuild) {
  const profiles = new ProfileStore(configDb), jobs = new BacktestJobStore(bioDb)
  const revision = profiles.validateRevision(input.revisionId, input.side)
  if (revision.hash !== input.expectedResolvedHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Candidate hash changed')
  if (profiles.binding(input.side).generation !== input.expectedGeneration) throw new ReferenceInputError('STALE_BINDING', 'Binding changed before verification')
  const storedJob = jobs.get(input.evaluationId)
  const job = backtestJobSnapshotSchema.parse(storedJob.input)
  const experiment = jobs.getExperiment(storedJob.experimentId)
  if (job.experimentId !== experiment.id || experiment.datasetId !== job.datasetId || experiment.side !== input.side
    || experiment.protocolHash !== job.protocolHash || configHash(experiment.protocol) !== job.protocolHash) throw new ReferenceInputError('EVALUATION_MISMATCH', 'Stored experiment and job disagree')
  const result = jobs.result(input.evaluationId)
  if (!result || result.contentHash !== input.expectedReportHash) throw new ReferenceInputError('EVALUATION_MISMATCH', 'Completed evaluation hash does not match')
  const dataset = new DatasetStore(bioDb).read(job.datasetId)
  const manifest = datasetManifestSchema.parse(dataset.manifest)
  const current = baseline(configDb, bioDb, input.side)
  const otherSide = input.side === 'left' ? 'right' : 'left'
  const other = job.protocol.mode === 'signal_replay' ? baseline(configDb, bioDb, otherSide) : null
  const evidence = verifyEvaluationAssessments(job, result, {
    side: input.side, revisionId: input.revisionId, resolvedHash: revision.hash, currentResolvedHash: current.hash,
    evaluatorBuildHash: build.evaluatorBuildHash,
    dataset: { id: dataset.id, contentHash: dataset.contentHash, side: dataset.side, available: dataset.available,
      holdoutCohortIds: manifest.splitProtocol.assignments.filter(row => row.split === 'holdout').map(row => row.cohortId) },
    ...(other && build.pythonBuildHash ? { waveform: { pythonBuildHash: build.pythonBuildHash, otherSideConfigHash: other.hash } } : {}),
  }, build.designations)
  return {
    evidence: { status: 'validated_reference_agreement' as const, evaluationId: input.evaluationId, ...evidence },
    recheck() {
      const latestJob = bioDb.select({ state: bioSchema.biometricBacktestJobs.state, fencingToken: bioSchema.biometricBacktestJobs.fencingToken })
        .from(bioSchema.biometricBacktestJobs).where(eq(bioSchema.biometricBacktestJobs.id, input.evaluationId)).get()
      const latestResult = bioDb.select({ fencingToken: bioSchema.biometricBacktestResults.fencingToken,
        contentHash: bioSchema.biometricBacktestResults.contentHash, releasedAtMs: bioSchema.biometricBacktestResults.releasedAtMs })
        .from(bioSchema.biometricBacktestResults).where(eq(bioSchema.biometricBacktestResults.jobId, input.evaluationId)).get()
      const latestDataset = bioDb.select({ contentHash: bioSchema.biometricDatasets.contentHash, releasedAtMs: bioSchema.biometricDatasets.releasedAtMs })
        .from(bioSchema.biometricDatasets).where(eq(bioSchema.biometricDatasets.id, dataset.id)).get()
      if (!latestJob || latestJob.state !== 'succeeded' || latestJob.fencingToken !== storedJob.fencingToken || !latestResult
        || latestResult.fencingToken !== storedJob.fencingToken || latestResult.contentHash !== result.contentHash || latestResult.releasedAtMs !== null
        || !latestDataset || latestDataset.contentHash !== dataset.contentHash || latestDataset.releasedAtMs !== null
        || jobs.holdoutUseCount(dataset.id) !== 1) throw new ReferenceInputError('EVALUATION_MISMATCH', 'Evaluation was released, replaced or reused before activation')
      const actual = baseline(configDb, bioDb, input.side)
      if (actual.hash !== current.hash || actual.provenance.generation !== current.provenance.generation
        || (other && baseline(configDb, bioDb, otherSide).hash !== other.hash)) throw new ReferenceInputError('EVALUATION_MISMATCH', 'Runtime baseline changed before activation')
    },
  }
}
