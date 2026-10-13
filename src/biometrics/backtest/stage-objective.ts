import { z } from 'zod'
import { operationalPolicySchema, operationalEvidenceSchema, assessOperationalEvidence } from './objective-policy'
const fraction = z.number().min(0).max(1)
const delta = z.number().min(-1).max(1)
const stage = z.enum(['wake', 'light', 'deep', 'rem'])
export const stageObjectivePolicySchema = z.object({
  version: z.literal('stage-objective-v1'), qualificationId: z.string().min(1).max(200),
  minimumNights: z.number().int().min(3).max(60),
  minimumPairedDurationMsPerNight: z.number().int().positive().max(86400000),
  minimumOutputCoverage: fraction, maximumLostOutputFraction: fraction,
  minimumAgreementImprovement: z.number().positive().max(1),
  maximumNightAgreementRegression: fraction, maximumRegressedNightFraction: fraction,
  maximumMacroF1Regression: fraction, maximumStageF1Regression: fraction,
  minimumStageReferenceMsPerNight: z.number().int().positive().max(86400000),
  requiredStages: z.array(stage).min(1).max(4).refine(rows => new Set(rows).size === rows.length, 'Duplicate required stages'),
  operational: operationalPolicySchema,
}).strict()
export type StageObjectivePolicy = z.infer<typeof stageObjectivePolicySchema>
export const stageObjectiveEvidenceSchema = z.object({
  split: z.enum(['tuning', 'validation', 'holdout']), holdoutUse: z.number().int().nonnegative(),
  intervalLower: delta.nullable(),
  nights: z.array(z.object({ cohortId: z.string(), pairedDurationMs: z.number().finite().nonnegative(),
    agreementDifference: delta.nullable(), macroF1Difference: delta.nullable(), candidateOutputCoverage: fraction.nullable(),
    baselineOutputMs: z.number().finite().nonnegative(), commonOutputMs: z.number().finite().nonnegative(),
    perStage: z.array(z.object({ stage, referenceMs: z.number().finite().nonnegative(), f1Difference: delta.nullable() }).strict()).max(4),
  }).strict()).max(60),
  operational: operationalEvidenceSchema.nullable(),
}).strict()
export type StageObjectiveEvidence = z.infer<typeof stageObjectiveEvidenceSchema>
export function assessStageObjective(rawPolicy: StageObjectivePolicy, rawEvidence: StageObjectiveEvidence, designation: StageObjectivePolicy | null) {
  const policy = stageObjectivePolicySchema.parse(rawPolicy), evidence = stageObjectiveEvidenceSchema.parse(rawEvidence)
  if (new Set(evidence.nights.map(row => row.cohortId)).size !== evidence.nights.length
    || evidence.nights.some(row => row.commonOutputMs > row.baselineOutputMs || row.pairedDurationMs > row.commonOutputMs
      || row.perStage.reduce((sum, item) => sum + item.referenceMs, 0) !== row.pairedDurationMs || new Set(row.perStage.map(item => item.stage)).size !== row.perStage.length)) throw new Error('Invalid stage objective evidence')
  const designated = designation !== null && JSON.stringify(stageObjectivePolicySchema.parse(designation)) === JSON.stringify(policy)
  const missing: string[] = [], failures: string[] = []
  if (!designated) missing.push('policy_not_designated')
  if (evidence.split !== 'holdout' || evidence.holdoutUse !== 1) missing.push('independent_holdout_required')
  const supported = evidence.nights.filter(row => row.agreementDifference !== null && row.pairedDurationMs >= policy.minimumPairedDurationMsPerNight)
  if (supported.length < policy.minimumNights) missing.push('insufficient_supported_nights')
  if (supported.length !== evidence.nights.length) missing.push('unsupported_nights')
  if (evidence.intervalLower === null) missing.push('uncertainty_unavailable')
  if (evidence.nights.some(row => row.candidateOutputCoverage === null || row.baselineOutputMs === 0)) missing.push('coverage_unavailable')
  if (evidence.nights.some(row => row.candidateOutputCoverage !== null && row.candidateOutputCoverage < policy.minimumOutputCoverage)) failures.push('output_coverage')
  if (evidence.nights.some(row => row.baselineOutputMs > 0 && (row.baselineOutputMs - row.commonOutputMs) / row.baselineOutputMs > policy.maximumLostOutputFraction)) failures.push('coverage_loss')
  const differences = supported.map(row => row.agreementDifference ?? 0)
  if (differences.some(value => value < -policy.maximumNightAgreementRegression)) failures.push('night_regression')
  if (differences.length && differences.filter(value => value < 0).length / differences.length > policy.maximumRegressedNightFraction) failures.push('regressed_night_fraction')
  if (evidence.nights.some(row => row.macroF1Difference === null)) missing.push('macro_f1_unavailable')
  if (evidence.nights.some(row => row.macroF1Difference !== null && row.macroF1Difference < -policy.maximumMacroF1Regression)) failures.push('macro_f1_regression')
  for (const required of policy.requiredStages) {
    const rows = evidence.nights.map(row => row.perStage.find(item => item.stage === required))
    if (rows.some(row => !row || row.referenceMs < policy.minimumStageReferenceMsPerNight || row.f1Difference === null)) missing.push(`stage_support:${required}`)
    if (rows.some(row => row?.f1Difference !== null && row?.f1Difference !== undefined && row.f1Difference < -policy.maximumStageF1Regression)) failures.push(`stage_regression:${required}`)
  }
  const operations = assessOperationalEvidence(policy.qualificationId, policy.operational, evidence.operational)
  missing.push(...operations.missing)
  failures.push(...operations.failures)
  const estimate = differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null
  const status = missing.length
    ? 'insufficient_evidence' as const
    : failures.length
      ? 'regressed' as const
      : estimate !== null && estimate >= policy.minimumAgreementImprovement && evidence.intervalLower !== null && evidence.intervalLower >= policy.minimumAgreementImprovement
        ? 'improved' as const
        : 'no_material_change' as const
  return { version: 'stage-objective-assessment-v1' as const, policy, evidence, designated, status, missingEvidence: missing, failedThresholds: failures,
    equalNightMeanAgreementDifference: estimate, intervalLower: evidence.intervalLower,
    interpretation: 'agreement_with_named_stage_reference_not_clinical_validation' as const }
}
