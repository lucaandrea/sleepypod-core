// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { combinePackageQualification } from './qualification'
import { fixtureResourceTestPolicy } from './resource-test-policy'
import { managedProtocolSchema } from './managed-protocol'

type Evidence = Parameters<typeof combinePackageQualification>[0]
type Accuracy = Parameters<typeof combinePackageQualification>[1]
function fixture() {
  const protocol = managedProtocolSchema.parse({ schema: 'biometric-managed-protocol-v1', hardwareId: 'pod4', sampleRateHz: 500,
    metricId: 'heart_rate', minimumQuality: 0.8, resourcePolicy: fixtureResourceTestPolicy,
    alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' },
    uncertainty: { version: 'paired-night-percentile-v1', seed: 'test', resamples: 200, minimumNights: 3 } })
  const accuracy: Accuracy = { schema: 'biometric-package-accuracy-assessment-v1', status: 'criteria_met', policyHash: 'a'.repeat(64), failures: [], missing: [],
    interpretation: 'reference_agreement_criteria_only_requires_full_package_qualification_and_review' }
  // The combiner consumes only the already-verified resource rows for each
  // night; comparisons themselves are evaluated by the accuracy assessor.
  const resources = (['default', 'current', 'candidate'] as const).map(label => ({ label,
    assessment: { status: 'within_observed_limits' as const, policyHash: configHash(protocol.resourcePolicy), failures: [], missing: [] } }))
  return { protocol, accuracy, resources }
}
function input(): { evidence: Evidence, accuracy: Accuracy } {
  const { protocol, accuracy, resources } = fixture()
  // Keep this input's type limited to exactly what combination reads.
  const evidence: Evidence = { protocol, preflight: { status: 'external_checks_passed', planHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), image: 'sha256:' + 'c'.repeat(64) },
    nights: [{ nightId: 'night', resources }] }
  return { evidence, accuracy }
}
describe('combined external package qualification', () => {
  it('combines passing dimensions but never grants installation', () => {
    const { evidence, accuracy } = input()
    expect(combinePackageQualification(evidence, accuracy)).toMatchObject({ status: 'external_criteria_met', failures: [], missing: [],
      installationAuthorized: false, remainingReleaseRequirements: expect.arrayContaining(['target_pod_compatibility_and_resource_qualification', 'reviewed_shipped_registry_release']) })
  })
  it('blocks missing or incomplete preflight even with passing accuracy', () => {
    const { evidence, accuracy } = input()
    evidence.preflight = null
    expect(combinePackageQualification(evidence, accuracy).missing).toContain('no_bound_preflight')
    evidence.preflight = { status: 'incomplete', planHash: 'a', packageHash: 'b', image: 'c' }
    expect(combinePackageQualification(evidence, accuracy).status).toBe('insufficient_evidence')
  })
  it('keeps failures dominant while retaining missing-evidence reasons', () => {
    const { evidence, accuracy } = input()
    accuracy.status = 'insufficient_evidence'
    if (evidence.preflight) evidence.preflight.status = 'failed'
    const result = combinePackageQualification(evidence, accuracy)
    expect(result).toMatchObject({ status: 'failed', failures: ['preflight_failed'], missing: ['accuracy_evidence_incomplete'] })
    accuracy.status = 'criteria_not_met'
    expect(combinePackageQualification(evidence, accuracy).failures).toContain('accuracy_criteria_not_met')
  })
  it('requires exact complete resource evidence for every baseline and candidate', () => {
    const { evidence, accuracy } = input()
    evidence.nights[0].resources.pop()
    expect(combinePackageQualification(evidence, accuracy).missing).toContain('night:candidate:resource_evidence_missing_or_ambiguous')
    evidence.nights[0].resources.push(evidence.nights[0].resources[0])
    expect(combinePackageQualification(evidence, accuracy).missing).toContain('night:default:resource_evidence_missing_or_ambiguous')
    evidence.nights = []
    expect(combinePackageQualification(evidence, accuracy).missing).toContain('no_night_resource_evidence')
  })
  it('rejects budget violations, inadequate sampling and substituted policies', () => {
    const { evidence, accuracy } = input()
    const candidate = evidence.nights[0].resources[2].assessment
    candidate.status = 'failed'
    candidate.policyHash = 'f'.repeat(64)
    const result = combinePackageQualification(evidence, accuracy)
    expect(result.failures).toEqual(expect.arrayContaining(['night:candidate:resource_policy_mismatch', 'night:candidate:resource_budget_failed']))
    candidate.status = 'insufficient_evidence'
    expect(combinePackageQualification(evidence, accuracy).missing).toContain('night:candidate:resource_evidence_incomplete')
  })
})
