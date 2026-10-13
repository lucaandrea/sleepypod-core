import { z } from 'zod'

const nonnegative = z.number().finite().nonnegative()
export const operationalPolicySchema = z.object({ maximumWallMs: z.number().int().positive(), maximumPeakRssBytes: z.number().int().positive(),
  maximumIngestionAgeMs: z.number().int().positive(),
  observations: z.object({ version: z.literal('sampled-process-group-v1'),
    maximumMemoryGapMs: z.number().int().positive(), maximumIngestionGapMs: z.number().int().positive(),
  }).strict().optional(),
}).strict()

/** Frozen with the experiment. Supplying thresholds never designates this as a
 * release promotion policy; that authority belongs to the qualified build. */
export const objectivePolicySchema = z.object({
  version: z.literal('numeric-objective-v1'),
  qualificationId: z.string().min(1).max(200),
  metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1']),
  minimumNights: z.number().int().min(3).max(60),
  minimumPairedReferencesPerNight: z.number().int().min(1).max(100000),
  maximumLostObservationFraction: z.number().min(0).max(1),
  minimumMaeImprovement: z.number().finite().positive(),
  maximumNightMaeRegression: nonnegative,
  maximumRegressedNightFraction: z.number().min(0).max(1),
  maximumSubgroupMaeRegression: nonnegative,
  requiredSubgroups: z.array(z.string().min(1).max(100)).max(20),
  operational: operationalPolicySchema,
}).strict().refine(policy => new Set(policy.requiredSubgroups).size === policy.requiredSubgroups.length, 'Duplicate objective subgroups')
export type ObjectivePolicy = z.infer<typeof objectivePolicySchema>

export const operationalEvidenceSchema = z.object({ wallMs: nonnegative, peakRssBytes: nonnegative, maximumIngestionAgeMs: nonnegative,
  observations: z.object({ version: z.literal('sampled-process-group-v1'), qualificationId: z.string(),
    maximumMemoryGapMs: nonnegative, maximumIngestionGapMs: nonnegative,
  }).strict().optional(),
}).strict()

const nightSchema = z.object({ cohortId: z.string(), pairedReferences: z.number().int().nonnegative(),
  maeDifference: z.number().finite().nullable(), baselineObservationCount: z.number().int().nonnegative(), lostObservations: z.number().int().nonnegative() }).strict()
export const objectiveEvidenceSchema = z.object({
  metricCompatible: z.boolean(), split: z.enum(['tuning', 'validation', 'holdout']), holdoutUse: z.number().int().nonnegative(),
  nights: z.array(nightSchema).max(60),
  intervalUpper: z.number().finite().nullable(),
  subgroups: z.array(z.object({ name: z.string(), pairedNights: z.number().int().nonnegative(), maeDifference: z.number().finite().nullable() }).strict()).max(20),
  operational: operationalEvidenceSchema.nullable(),
}).strict()
export type ObjectiveEvidence = z.infer<typeof objectiveEvidenceSchema>

/** Pure assessment. Designation is supplied by a trusted build dependency, not
 * experiment JSON. No clinical accuracy or activation is inferred. */
export function assessNumericObjective(rawPolicy: ObjectivePolicy, rawEvidence: ObjectiveEvidence, designatedPolicy: ObjectivePolicy | null) {
  const policy = objectivePolicySchema.parse(rawPolicy), evidence = objectiveEvidenceSchema.parse(rawEvidence)
  if (new Set(evidence.nights.map(night => night.cohortId)).size !== evidence.nights.length
    || new Set(evidence.subgroups.map(group => group.name)).size !== evidence.subgroups.length
    || evidence.nights.some(night => night.lostObservations > night.baselineObservationCount)) throw new Error('Invalid objective evidence identity or coverage')
  const designated = designatedPolicy !== null && JSON.stringify(objectivePolicySchema.parse(designatedPolicy)) === JSON.stringify(policy)
  const missing: string[] = [], failures: string[] = []
  if (!designated) missing.push('policy_not_designated')
  if (evidence.split !== 'holdout' || evidence.holdoutUse !== 1) missing.push('independent_holdout_required')
  const scored = evidence.nights.filter(night => night.maeDifference !== null && night.pairedReferences >= policy.minimumPairedReferencesPerNight)
  if (scored.length < policy.minimumNights) missing.push('insufficient_supported_nights')
  if (scored.length !== evidence.nights.length) missing.push('unsupported_nights')
  if (evidence.intervalUpper === null) missing.push('uncertainty_unavailable')
  const operational = assessOperationalEvidence(policy.qualificationId, policy.operational, evidence.operational)
  missing.push(...operational.missing)
  failures.push(...operational.failures)
  if (evidence.nights.some(night => night.baselineObservationCount === 0)) missing.push('coverage_unavailable')
  if (evidence.nights.some(night => night.baselineObservationCount > 0 && night.lostObservations / night.baselineObservationCount > policy.maximumLostObservationFraction)) failures.push('coverage_loss')
  const deltas = scored.map(night => night.maeDifference ?? 0)
  if (deltas.some(delta => delta > policy.maximumNightMaeRegression)) failures.push('night_regression')
  if (deltas.length && deltas.filter(delta => delta > 0).length / deltas.length > policy.maximumRegressedNightFraction) failures.push('regressed_night_fraction')
  for (const name of policy.requiredSubgroups) {
    const group = evidence.subgroups.find(row => row.name === name)
    if (!group || group.maeDifference === null || group.pairedNights < policy.minimumNights) missing.push(`subgroup_support:${name}`)
    else if (group.maeDifference > policy.maximumSubgroupMaeRegression) failures.push(`subgroup_regression:${name}`)
  }
  const estimate = deltas.length ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : null
  const status = !evidence.metricCompatible
    ? 'incompatible' as const
    : missing.length
      ? 'insufficient_evidence' as const
      : failures.length
        ? 'regressed' as const
        : estimate !== null && estimate <= -policy.minimumMaeImprovement && evidence.intervalUpper !== null && evidence.intervalUpper <= -policy.minimumMaeImprovement
          ? 'improved' as const
          : 'no_material_change' as const
  return { version: 'numeric-objective-assessment-v1' as const, policy, evidence, designated, status, missingEvidence: missing, failedThresholds: failures,
    equalNightMeanMaeDifference: estimate, intervalUpper: evidence.intervalUpper,
    interpretation: 'agreement_with_named_reference_not_clinical_validation' as const }
}

export function assessOperationalEvidence(qualificationId: string, policy: z.infer<typeof operationalPolicySchema>, evidence: z.infer<typeof operationalEvidenceSchema> | null) {
  const missing: string[] = [], failures: string[] = []
  if (!evidence) missing.push('operational_evidence_unavailable')
  else {
    const required = policy.observations, observed = evidence.observations
    if (required && !observed) missing.push('operational_sampling_evidence_unavailable')
    if (!required && observed) missing.push('sampled_memory_not_authorized_by_policy')
    if (required && observed) {
      if (observed.qualificationId !== qualificationId) missing.push('operational_qualification_mismatch')
      if (observed.maximumMemoryGapMs > required.maximumMemoryGapMs) missing.push('memory_sampling_gap')
      if (observed.maximumIngestionGapMs > required.maximumIngestionGapMs) missing.push('ingestion_sampling_gap')
    }
    if (evidence.wallMs > policy.maximumWallMs) failures.push('wall_time_limit')
    if (evidence.peakRssBytes > policy.maximumPeakRssBytes) failures.push('memory_limit')
    if (evidence.maximumIngestionAgeMs > policy.maximumIngestionAgeMs) failures.push('ingestion_limit')
  }
  return { missing, failures }
}
