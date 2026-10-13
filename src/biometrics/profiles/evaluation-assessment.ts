import { verifyReplayContext, type ReplayContextQualification } from './replay-context'
import { numericObjectivePolicies } from '../backtest/contracts'
import { z } from 'zod'
import { configHash } from '../algorithms/canonical'
import { validateConfig } from '../algorithms/registry'
import { finalizeObjectiveReport, finalizeStageObjectiveReport } from '../backtest/objective-finalization'
import type { ObjectivePolicy } from '../backtest/objective-policy'
import type { StageObjectivePolicy } from '../backtest/stage-objective'
import { ReferenceInputError } from '../references/time'
import { verifyEvaluationIdentity } from './evaluation-identity'

const assessmentSchema = z.object({
  baseline: z.enum(['default', 'current']), candidate: z.literal('candidate'), baselineHash: z.string(), candidateHash: z.string(),
  status: z.enum(['improved', 'no_material_change', 'regressed', 'insufficient_evidence', 'incompatible']),
  designated: z.boolean(), missingEvidence: z.array(z.string()), failedThresholds: z.array(z.string()),
  evidence: z.object({ split: z.literal('holdout'), holdoutUse: z.literal(1), nights: z.array(z.object({ cohortId: z.string() })) }),
})

/** Internal qualified-build dependency, never populated from experiment JSON. */
export interface DesignatedEvaluationPolicies {
  /** Full frozen protocol, including alignment/calibration/uncertainty settings. */
  protocolHash: string | null
  waveformContext: ReplayContextQualification | null
  numeric: ObjectivePolicy | readonly ObjectivePolicy[] | null
  stages: StageObjectivePolicy | null
}

/** Reassess retained evidence; claimed report statuses are never authority.
 * The caller still must commit activation under a current binding generation
 * and recheck holdout exposure immediately before that commit. */
export function assessEvaluation(
  rawJob: Parameters<typeof verifyEvaluationIdentity>[0],
  result: Parameters<typeof verifyEvaluationIdentity>[1],
  expected: Parameters<typeof verifyEvaluationIdentity>[2],
  designations: DesignatedEvaluationPolicies,
) {
  const identity = verifyEvaluationIdentity(rawJob, result, expected)
  const reject = (message: string): never => {
    throw new ReferenceInputError('EVALUATION_NOT_VALIDATED', message)
  }
  const { job } = identity
  const configuration = (label: 'candidate' | 'current' | 'default') => job.configs.find(row => row.label === label) ?? reject('Missing evaluated configuration')
  const candidate = configuration('candidate')
  const current = configuration('current')
  const after = validateConfig(candidate.resolved), before = validateConfig(current.resolved)
  const domains = (Object.keys(after) as Array<keyof typeof after>).filter(domain => configHash(after[domain]) !== configHash(before[domain]))
  if (!domains.length) reject('Candidate does not change the current configuration')
  const numericMetrics = { heart_rate: 'heart_rate', breathing_rate: 'breathing_rate', hrv_index: 'window_ibi_variability_v1' } as const
  const requiredMetrics = domains.filter((domain): domain is keyof typeof numericMetrics => domain !== 'sleep_stages').map(domain => numericMetrics[domain])
  const policies = numericObjectivePolicies(job.protocol)
  if (requiredMetrics.some(metric => !policies.some(policy => policy.metric === metric))) reject('Every changed numeric component requires its own objective evidence')
  if (!job.protocol.stageObjectivePolicy) reject('Stage agreement and downstream effects require stage objective evidence')
  if (requiredMetrics.length && (job.protocol.mode !== 'signal_replay' || job.protocol.waveformStages !== true)) reject('Numeric changes require waveform replay with downstream stages')
  const raw = z.record(z.string(), z.unknown()).parse(result.report)
  const numeric = finalizeObjectiveReport(raw, policies, raw.jobOperations, designations.numeric)
  const finalized = finalizeStageObjectiveReport(numeric, job.protocol.stageObjectivePolicy, raw.jobOperations, designations.stages)
  const outcomes: Array<{ status: string, designated: boolean, missingEvidence: string[], failedThresholds: string[], improvementRequired: boolean }> = []
  const check = (rawAssessments: unknown, improvementRequired: boolean) => {
    const assessments = z.array(assessmentSchema).length(2).parse(rawAssessments)
    for (const assessment of assessments) {
      const baseline = configuration(assessment.baseline)
      if (assessment.baselineHash !== baseline.resolvedHash || assessment.candidateHash !== candidate.resolvedHash) reject('Objective evidence belongs to another configuration')
      const cohorts = assessment.evidence.nights.map(row => row.cohortId)
      if (new Set(cohorts).size !== cohorts.length || cohorts.length !== identity.cohortIds.length
        || cohorts.some(id => !identity.cohortIds.includes(id))) reject('Objective evidence omits frozen holdout nights')
      outcomes.push({ ...assessment, improvementRequired })
    }
    return assessments.map(row => ({ baseline: row.baseline, baselineHash: row.baselineHash, candidateHash: row.candidateHash, status: row.status }))
  }
  const numericRows = z.array(z.object({ policy: z.object({ metric: z.string() }) }).passthrough()).parse(finalized.objectiveAssessments ?? [])
  const numericAssessments = policies.flatMap(policy => check(numericRows.filter(row => row.policy.metric === policy.metric), true)
    .map(row => ({ ...row, metric: policy.metric })))
  const stageAssessments = check(finalized.stageObjectiveAssessments, domains.includes('sleep_stages'))
  if (designations.protocolHash !== job.protocolHash) reject('Evaluation protocol is outside the qualified context')
  const replayContext = expected.waveform
    ? verifyReplayContext(raw.waveform, { ...expected.waveform, side: expected.side,
        cohortIds: identity.cohortIds, configHashes: job.configs.map(config => config.resolvedHash) }, designations.waveformContext)
    : null
  const status = outcomes.some(row => row.status === 'incompatible')
    ? 'incompatible' as const
    : outcomes.some(row => !row.designated || row.missingEvidence.length || row.status === 'insufficient_evidence')
      ? 'insufficient_evidence' as const
      : outcomes.some(row => row.failedThresholds.length || row.status === 'regressed')
        ? 'regressed' as const
        : outcomes.every(row => row.status === 'improved' || (!row.improvementRequired && row.status === 'no_material_change'))
          ? 'improved' as const
          : 'no_material_change' as const
  return { status, audit: { version: 'verified-evaluation-v1' as const, interpretation: 'agreement_with_named_reference_not_clinical_validation' as const,
    reportHash: result.contentHash, revisionId: expected.revisionId, resolvedHash: expected.resolvedHash,
    currentResolvedHash: expected.currentResolvedHash, datasetId: job.datasetId, datasetHash: job.datasetHash,
    evaluatorBuildHash: job.evaluatorBuildHash, manifestHash: identity.report.manifestHash, protocolHash: job.protocolHash,
    changedDomains: domains, numericAssessments, stageAssessments, replayContext,
    policies: { numeric: job.protocol.objectivePolicies ?? job.protocol.objectivePolicy ?? null, stages: job.protocol.stageObjectivePolicy },
    ...(expected.waveform ? { waveform: expected.waveform } : {}),
  } }
}

/** Activation requires the independently reassessed whole candidate to improve. */
export function verifyEvaluationAssessments(...args: Parameters<typeof assessEvaluation>) {
  const result = assessEvaluation(...args)
  if (result.status !== 'improved') throw new ReferenceInputError('EVALUATION_NOT_VALIDATED', 'Objective evidence does not support this activation')
  return result.audit
}
