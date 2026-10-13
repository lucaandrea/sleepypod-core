// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compareNumericConfigurations } from '../../src/biometrics/backtest/numeric-comparison'
import { createNightUncertainty } from '../../src/biometrics/backtest/uncertainty-core'
import { normalizeReferenceImport } from '../../src/biometrics/references/normalize-core'
import { assessPackageAccuracy } from './accuracy'
import { managedProtocolSchema } from './managed-protocol'
import { fixtureResourceTestPolicy } from './resource-test-policy'
import { configHash } from '../../src/biometrics/algorithms/canonical'

type Input = Parameters<typeof assessPackageAccuracy>[0]
const policy = { schema: 'biometric-package-accuracy-policy-v1', minimumMaeImprovement: 0.5, maximumNightMaeRegression: 0,
  maximumNightP95Regression: 0, maximumNightAbsoluteBiasIncrease: 0, minimumCommonPairsPerNight: 2,
  minimumReferenceCoverage: 1, maximumReferenceCoverageLoss: 0, maximumLostTimestampFraction: 0 }
function fixture(): Input {
  const protocol = managedProtocolSchema.parse({ schema: 'biometric-managed-protocol-v1', hardwareId: 'pod4', sampleRateHz: 500, metricId: 'heart_rate', minimumQuality: 0.8,
    alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' },
    uncertainty: { version: 'paired-night-percentile-v1', seed: 'accuracy-test', resamples: 200, minimumNights: 3 },
    resourcePolicy: fixtureResourceTestPolicy, accuracyPolicy: policy })
  const reference = normalizeReferenceImport({ subjectId: 'fixture', side: 'left', source: 'synthetic',
    rows: [0, 1].map(index => ({ recordKey: String(index), metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: 1700000000000 + index * 1000 })) })
  const nights = [0, 1, 2].map((index) => {
    const outputs = (['default', 'current', 'candidate'] as const).map((label, variant) => ({ label, configHash: String(variant),
      observations: [0, 1].map(point => ({ timestampMs: 1700000000000 + point * 1000, value: variant === 2 ? 60 : 64 + index + (1 - variant) })) }))
    const comparison = { schema: 'biometric-package-comparison-report-v1' as const, inputHash: 'a', referenceHash: 'b', metricId: 'heart_rate',
      contract: { metric: 'heart_rate' as const, windowMs: null }, alignment: protocol.alignment, startMs: 1700000000000, endMs: 1700000060000,
      minimumQuality: 0.8, excludedBoundaryReferences: 0, compatibilityExclusions: {}, referenceSummary: reference.summary,
      comparisons: compareNumericConfigurations('heart_rate', null, outputs, reference.measurements, protocol.alignment),
      interpretation: 'descriptive_reference_agreement_not_independent_holdout_or_promotion_evidence' as const }
    return { nightId: String(index), reportHash: 'c', comparison, resources: [] }
  })
  const uncertainty = createNightUncertainty(text => createHash('sha256').update(text).digest(), 'equal_night_mean_common_mae_difference')
  return { protocol, nights, uncertainty: (['default', 'current'] as const).map(baseline => ({ baseline,
    report: uncertainty(nights.map(night => ({ cohortId: night.nightId, difference: night.comparison.comparisons.find(row => row.baseline === baseline && row.candidate === 'candidate')?.differences.commonMae ?? null })), protocol.uncertainty) })),
  currentEvidence: { trialId: 'fixture', state: 'succeeded', reportHash: 'hash', otherExposures: [], uniqueHoldoutAttempt: true } }
}
describe('frozen package accuracy criteria', () => {
  it('requires supported improvement against both baselines without authorizing installation', () => {
    expect(assessPackageAccuracy(fixture())).toMatchObject({ status: 'criteria_met', failures: [], missing: [], interpretation: expect.stringContaining('requires_full_package') })
    const input = fixture()
    const report = input.uncertainty[1].report
    if (report.interval) report.interval.upper = 0
    expect(assessPackageAccuracy(input)).toMatchObject({ status: 'criteria_not_met', failures: ['current:improvement_not_supported'] })
  })
  it('cannot backfill criteria into an already frozen protocol or reuse exposed holdout', () => {
    const input = fixture(), frozen = configHash(input.protocol)
    delete input.protocol.accuracyPolicy
    expect(configHash(input.protocol)).not.toBe(frozen)
    expect(assessPackageAccuracy(input).missing).toContain('no_frozen_accuracy_policy')
    input.currentEvidence.uniqueHoldoutAttempt = false
    expect(assessPackageAccuracy(input).missing).toContain('no_unique_current_holdout')
  })
  it('rejects coverage loss and individual-night regressions even with favorable aggregate intervals', () => {
    const input = fixture()
    const row = input.nights[0].comparison.comparisons.find(row => row.candidate === 'candidate' && row.baseline === 'default')
    if (!row) throw new Error('Missing fixture comparison')
    row.ownSupport.candidate.referenceCoverage = 0.5
    row.differences.referenceCoverage = -0.5
    row.lostObservationTimestamps = 1
    row.differences.commonMae = 1
    row.differences.commonP95AbsoluteError = 2
    if (row.commonSupport.candidate.metrics) row.commonSupport.candidate.metrics.signedBias = 99
    const result = assessPackageAccuracy(input)
    expect(result.status).toBe('criteria_not_met')
    expect(result.failures).toEqual(expect.arrayContaining(['0:default:reference_coverage_below_minimum', '0:default:reference_coverage_loss',
      '0:default:observation_support_loss', '0:default:night_mae_regression', '0:default:night_tail_regression', '0:default:night_bias_regression']))
  })
  it('does not treat omitted nights, missing pairs or degenerate intervals as successful evidence', () => {
    const input = fixture()
    input.uncertainty[0].report.omittedNights = 1
    input.uncertainty[1].report = { ...input.uncertainty[1].report, status: 'degenerate', interval: null }
    const row = input.nights[0].comparison.comparisons.find(row => row.candidate === 'candidate' && row.baseline === 'default')
    if (!row) throw new Error('Missing fixture comparison')
    row.commonSupport.candidate.pairedCount = 0
    row.ambiguousObservationTimestamps.candidate = 1
    expect(assessPackageAccuracy(input)).toMatchObject({ status: 'insufficient_evidence', missing: expect.arrayContaining([
      'default:insufficient_whole_night_uncertainty', 'current:insufficient_whole_night_uncertainty',
      '0:default:insufficient_common_pairs', '0:default:ambiguous_observation_support',
    ]) })
  })
})
