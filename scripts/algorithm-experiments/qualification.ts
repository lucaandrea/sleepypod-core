import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { assessPackageAccuracy } from './accuracy'
import { readManagedEvidence } from './managed-evidence'

type Evidence = ReturnType<typeof readManagedEvidence>
type Accuracy = ReturnType<typeof assessPackageAccuracy>

/** Combine verified external checks. This is deliberately not a registry entry
 * or activation authorization: target-pod and release review are still needed. */
export function combinePackageQualification(evidence: Pick<Evidence, 'preflight' | 'protocol'> & { nights: Pick<Evidence['nights'][number], 'nightId' | 'resources'>[] }, accuracy: Accuracy) {
  const failures: string[] = [], missing: string[] = []
  if (accuracy.status === 'criteria_not_met') failures.push('accuracy_criteria_not_met')
  if (accuracy.status === 'insufficient_evidence' || accuracy.missing.length) missing.push('accuracy_evidence_incomplete')
  if (!evidence.preflight) missing.push('no_bound_preflight')
  else if (evidence.preflight.status === 'failed') failures.push('preflight_failed')
  else if (evidence.preflight.status !== 'external_checks_passed') missing.push('preflight_incomplete')
  const resourcePolicyHash = configHash(evidence.protocol.resourcePolicy)
  if (!evidence.nights.length) missing.push('no_night_resource_evidence')
  const resources = evidence.nights.map((night) => {
    for (const label of ['default', 'current', 'candidate'] as const) {
      const selected = night.resources.filter(row => row.label === label)
      if (selected.length !== 1) {
        missing.push(`${night.nightId}:${label}:resource_evidence_missing_or_ambiguous`)
        continue
      }
      const assessment = selected[0].assessment
      if (assessment.policyHash !== resourcePolicyHash) failures.push(`${night.nightId}:${label}:resource_policy_mismatch`)
      if (assessment.status === 'failed') failures.push(`${night.nightId}:${label}:resource_budget_failed`)
      if (assessment.status === 'insufficient_evidence' || ('missing' in assessment && assessment.missing?.length)) missing.push(`${night.nightId}:${label}:resource_evidence_incomplete`)
    }
    return { nightId: night.nightId, assessments: night.resources }
  })
  return { schema: 'biometric-package-qualification-assessment-v1' as const,
    status: failures.length ? 'failed' as const : missing.length ? 'insufficient_evidence' as const : 'external_criteria_met' as const,
    failures, missing, accuracy, preflight: evidence.preflight, resourcePolicyHash, resources,
    installationAuthorized: false as const,
    remainingReleaseRequirements: ['representative_fixture_review', 'target_pod_compatibility_and_resource_qualification',
      'prospective_health_and_reference_comparison', 'reviewed_shipped_registry_release'] as const,
    interpretation: 'external_evidence_snapshot_not_installation_or_activation_authorization' as const }
}

/** The public orchestration entry point accepts ledger identities, never a
 * client-authored success report. Re-read for every review: later overlapping
 * holdout access changes the evidence and therefore the assessment hash. */
export function assessManagedQualification(...args: Parameters<typeof readManagedEvidence>) {
  const evidence = readManagedEvidence(...args)
  const accuracy = assessPackageAccuracy(evidence)
  const qualification = combinePackageQualification(evidence, accuracy)
  const snapshot = { trialId: evidence.trialId, reportHash: evidence.reportHash, protocolHash: configHash(evidence.protocol),
    request: evidence.request, currentEvidence: evidence.currentEvidence, qualification }
  return { ...snapshot, assessmentHash: dataHash(snapshot) }
}
