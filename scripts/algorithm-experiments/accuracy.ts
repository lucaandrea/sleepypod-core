import { configHash } from '../../src/biometrics/algorithms/canonical'
import { packageAccuracyPolicySchema } from './accuracy-policy'
import { readManagedEvidence } from './managed-evidence'

type Evidence = ReturnType<typeof readManagedEvidence>
type AccuracyInput = Pick<Evidence, 'protocol' | 'nights' | 'uncertainty' | 'currentEvidence'>

/** Pure assessment of already verified evidence. The authoritative entry point
 * below reads the retained graph and fresh ledger state first. */
export function assessPackageAccuracy(evidence: AccuracyInput) {
  const failures: string[] = [], missing: string[] = []
  const rawPolicy = evidence.protocol.accuracyPolicy
  const policy = rawPolicy === undefined ? null : packageAccuracyPolicySchema.parse(rawPolicy)
  if (!policy) missing.push('no_frozen_accuracy_policy')
  if (!evidence.currentEvidence.uniqueHoldoutAttempt) missing.push('no_unique_current_holdout')
  if (!evidence.nights.length) missing.push('no_nights')
  for (const night of evidence.nights) {
    for (const baseline of ['default', 'current'] as const) {
      const key = `${night.nightId}:${baseline}`
      const comparison = night.comparison.comparisons.find(row => row.candidate === 'candidate' && row.baseline === baseline)
      if (!comparison) {
        missing.push(`${key}:missing_comparison`)
        continue
      }
      if (comparison.commonSupport.candidate.status === 'incompatible' || comparison.commonSupport.baseline.status === 'incompatible') {
        failures.push(`${key}:incompatible_metric`)
        continue
      }
      if (comparison.ambiguousObservationTimestamps.baseline || comparison.ambiguousObservationTimestamps.candidate) missing.push(`${key}:ambiguous_observation_support`)
      if (!policy) continue
      const candidate = comparison.commonSupport.candidate, previous = comparison.commonSupport.baseline
      if (!candidate.metrics || !previous.metrics || candidate.pairedCount < policy.minimumCommonPairsPerNight
        || previous.pairedCount < policy.minimumCommonPairsPerNight) missing.push(`${key}:insufficient_common_pairs`)
      const own = comparison.ownSupport.candidate
      if (own.referenceCoverage === null) missing.push(`${key}:missing_reference_coverage`)
      else if (own.referenceCoverage < policy.minimumReferenceCoverage) failures.push(`${key}:reference_coverage_below_minimum`)
      const coverageChange = comparison.differences.referenceCoverage
      if (coverageChange === null) missing.push(`${key}:missing_coverage_difference`)
      else if (coverageChange < -policy.maximumReferenceCoverageLoss) failures.push(`${key}:reference_coverage_loss`)
      const baselineCount = comparison.ownSupport.baseline.validObservationCount
      if (!baselineCount) missing.push(`${key}:missing_baseline_observations`)
      else if (comparison.lostObservationTimestamps / baselineCount > policy.maximumLostTimestampFraction) failures.push(`${key}:observation_support_loss`)
      if (comparison.differences.commonMae !== null && comparison.differences.commonMae > policy.maximumNightMaeRegression) failures.push(`${key}:night_mae_regression`)
      if (comparison.differences.commonP95AbsoluteError !== null && comparison.differences.commonP95AbsoluteError > policy.maximumNightP95Regression) failures.push(`${key}:night_tail_regression`)
      if (candidate.metrics && previous.metrics
        && Math.abs(candidate.metrics.signedBias) - Math.abs(previous.metrics.signedBias) > policy.maximumNightAbsoluteBiasIncrease) failures.push(`${key}:night_bias_regression`)
    }
  }
  for (const baseline of ['default', 'current'] as const) {
    const report = evidence.uncertainty.find(row => row.baseline === baseline)?.report
    if (!report || report.status !== 'estimated' || !report.interval || report.omittedNights > 0
      || report.scoredNights !== evidence.nights.length) missing.push(`${baseline}:insufficient_whole_night_uncertainty`)
    else if (policy && (report.estimate === null || report.estimate > -policy.minimumMaeImprovement
      || report.interval.upper > -policy.minimumMaeImprovement)) failures.push(`${baseline}:improvement_not_supported`)
  }
  return { schema: 'biometric-package-accuracy-assessment-v1' as const,
    status: failures.length ? 'criteria_not_met' as const : missing.length ? 'insufficient_evidence' as const : 'criteria_met' as const,
    policyHash: policy ? configHash(policy) : null, failures, missing,
    interpretation: 'reference_agreement_criteria_only_requires_full_package_qualification_and_review' as const }
}

export function assessManagedAccuracy(...args: Parameters<typeof readManagedEvidence>) {
  const evidence = readManagedEvidence(...args)
  return { trialId: evidence.trialId, reportHash: evidence.reportHash, currentEvidence: evidence.currentEvidence,
    assessment: assessPackageAccuracy(evidence), preflight: evidence.preflight }
}
