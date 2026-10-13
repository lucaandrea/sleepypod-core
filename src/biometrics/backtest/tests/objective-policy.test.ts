// @vitest-environment node
import { expect, it } from 'vitest'
import { assessNumericObjective, type ObjectiveEvidence, type ObjectivePolicy } from '../objective-policy'
import { experimentProtocolSchema } from '../contracts'
import { configHash } from '../../algorithms/canonical'
const policy: ObjectivePolicy = { version: 'numeric-objective-v1', qualificationId: 'test-only', metric: 'heart_rate', minimumNights: 3,
  minimumPairedReferencesPerNight: 10, maximumLostObservationFraction: 0.1, minimumMaeImprovement: 2,
  maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0.34, maximumSubgroupMaeRegression: 1, requiredSubgroups: ['motion'],
  operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } }
const evidence = (): ObjectiveEvidence => ({ metricCompatible: true, split: 'holdout', holdoutUse: 1,
  nights: ['a', 'b', 'c'].map(cohortId => ({ cohortId, pairedReferences: 10, maeDifference: -2, baselineObservationCount: 10, lostObservations: 1 })),
  intervalUpper: -2, subgroups: [{ name: 'motion', pairedNights: 3, maeDifference: 1 }], operational: { wallMs: 1000, peakRssBytes: 1000, maximumIngestionAgeMs: 1000 } })
it('only a designated qualified policy can award improvement at exact thresholds', () => {
  expect(assessNumericObjective(policy, evidence(), policy).status).toBe('improved')
  expect(assessNumericObjective(policy, evidence(), null)).toMatchObject({ status: 'insufficient_evidence', missingEvidence: ['policy_not_designated'] })
  expect(assessNumericObjective(policy, evidence(), { ...policy, qualificationId: 'different' }).status).toBe('insufficient_evidence')
})
it('requires independent support, uncertainty, subgroups and measured operations', () => {
  for (const patch of [{ split: 'tuning' as const }, { holdoutUse: 2 }, { intervalUpper: null }, { subgroups: [] }, { operational: null },
    { nights: evidence().nights.slice(0, 2) }, { nights: evidence().nights.map(row => ({ ...row, pairedReferences: 9 })) }]) {
    expect(assessNumericObjective(policy, { ...evidence(), ...patch }, policy).status).toBe('insufficient_evidence')
  }
  expect(assessNumericObjective(policy, { ...evidence(), metricCompatible: false }, policy).status).toBe('incompatible')
})
it('checks strict operational and coverage boundaries', () => {
  for (const key of ['wallMs', 'peakRssBytes', 'maximumIngestionAgeMs'] as const) {
    expect(assessNumericObjective(policy, { ...evidence(), operational: { wallMs: 1000, peakRssBytes: 1000, maximumIngestionAgeMs: 1000, [key]: 1001 } }, policy).status).toBe('regressed')
  }
  const data = evidence()
  data.nights[0].lostObservations = 2
  expect(assessNumericObjective(policy, data, policy).failedThresholds).toContain('coverage_loss')
})
it('does not hide night or subgroup regressions behind a better mean', () => {
  const data = evidence()
  data.nights[0].maeDifference = 1.01
  expect(assessNumericObjective(policy, data, policy).failedThresholds).toContain('night_regression')
  data.nights[0].maeDifference = 1
  data.nights[1].maeDifference = 1
  expect(assessNumericObjective(policy, data, policy).failedThresholds).toContain('regressed_night_fraction')
  data.subgroups[0].maeDifference = 1.01
  expect(assessNumericObjective(policy, data, policy).failedThresholds).toContain('subgroup_regression:motion')
  expect(assessNumericObjective(policy, { ...evidence(), intervalUpper: -1.99 }, policy).status).toBe('no_material_change')
})
it('pins thresholds in protocol identity and rejects duplicate evidence', () => {
  const base = { version: 'descriptive-evaluation-v1', mode: 'signal_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0, objectivePolicy: policy }
  expect(experimentProtocolSchema.safeParse({ ...base, mode: 'comparison' }).success).toBe(false)
  const first = experimentProtocolSchema.parse(base)
  const second = experimentProtocolSchema.parse({ ...base, objectivePolicy: { ...policy, minimumMaeImprovement: 3 } })
  expect(configHash(first)).not.toBe(configHash(second))
  const data = evidence()
  data.nights.push(data.nights[0])
  expect(() => assessNumericObjective(policy, data, policy)).toThrow('identity')
})

it('freezes one policy per numeric metric without rewriting legacy protocols', () => {
  const base = { version: 'descriptive-evaluation-v1', mode: 'signal_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
  const policies = ['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'].map(metric => ({ ...policy, metric }))
  expect(experimentProtocolSchema.parse({ ...base, objectivePolicies: policies }).objectivePolicies).toEqual(policies)
  expect(experimentProtocolSchema.parse({ ...base, objectivePolicy: policy })).not.toHaveProperty('objectivePolicies')
  for (const patch of [{ objectivePolicies: [] }, { objectivePolicies: [policy, policy] }, { objectivePolicies: policies, objectivePolicy: policy },
    { objectivePolicies: policies, mode: 'comparison' }, { objectivePolicies: policies, mode: 'stage_replay' }]) {
    expect(experimentProtocolSchema.safeParse({ ...base, ...patch }).success).toBe(false)
  }
})
