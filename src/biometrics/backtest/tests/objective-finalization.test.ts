// @vitest-environment node
import { expect, it } from 'vitest'
import { assessNumericObjective, type ObjectivePolicy, type ObjectiveEvidence } from '../objective-policy'
import { finalizeObjectiveReport, objectiveOperations } from '../objective-finalization'
import type { createJobOperations } from '../job-operations'
const policy: ObjectivePolicy = { version: 'numeric-objective-v1', qualificationId: 'qualified-test', metric: 'heart_rate', minimumNights: 3,
  minimumPairedReferencesPerNight: 10, maximumLostObservationFraction: 0.1, minimumMaeImprovement: 2, maximumNightMaeRegression: 1,
  maximumRegressedNightFraction: 0.34, maximumSubgroupMaeRegression: 1, requiredSubgroups: [],
  operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000,
    observations: { version: 'sampled-process-group-v1', maximumMemoryGapMs: 1000, maximumIngestionGapMs: 5000 } } }
const evidence: ObjectiveEvidence = { metricCompatible: true, split: 'holdout', holdoutUse: 1, intervalUpper: -2, subgroups: [], operational: null,
  nights: ['a', 'b', 'c'].map(cohortId => ({ cohortId, pairedReferences: 10, maeDifference: -2, baselineObservationCount: 10, lostObservations: 1 })) }
const operations = (): ReturnType<ReturnType<typeof createJobOperations>['finish']> => ({ version: 'backtest-job-operations-v1', wallMs: 1000,
  scope: 'admission_through_prepublication', memory: { version: 'process-group-rss-observations-v1', scope: 'sum_rss_of_replay_process_group',
    attempts: 3, samples: 3, allSamplesAvailable: true, peakObservedRssBytes: 1000, maximumObservationGapMs: 1000, intervalMs: 1000, exactKernelPeak: false },
  ingestion: { source: 'supervisor_live_piezo_receipt_age', checks: 2, samples: 2, allChecksMeasured: true, qualificationId: 'qualified-test',
    maximumObservedAgeMs: 1000, maximumObservationGapMs: 5000, nominalIntervalMs: 5000, continuousMeasurement: false } })
const report = () => ({ objectiveAssessments: ['default', 'current'].map(baseline => ({ baseline, candidate: 'candidate', baselineHash: baseline,
  candidateHash: 'candidate', ...assessNumericObjective(policy, evidence, null) })) })
it('finalizes measured operational evidence only under explicit sampled policy and trusted designation', () => {
  const result = finalizeObjectiveReport(report(), policy, operations(), policy)
  expect(result.objectiveAssessments).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'improved', evidence: { ...evidence, operational: objectiveOperations(operations(), policy) } })]))
  expect(finalizeObjectiveReport(report(), policy, operations(), null).objectiveAssessments).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'insufficient_evidence', missingEvidence: ['policy_not_designated'] })]))
})
it('does not repurpose sampled peaks for legacy policies or incomplete observations', () => {
  const legacy = { ...policy, operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } }
  expect(objectiveOperations(operations(), legacy)).toBeNull()
  for (const patch of [{ memory: null }, { memory: { ...operations().memory, samples: 1 } },
    { ingestion: { ...operations().ingestion, allChecksMeasured: false } }, { ingestion: { ...operations().ingestion, qualificationId: null } }]) {
    expect(objectiveOperations({ ...operations(), ...patch }, policy)).toBeNull()
  }
})
it('treats sampling gaps and qualification mismatches as missing evidence at strict boundaries', () => {
  for (const patch of [{ maximumIngestionGapMs: 5001 }, { maximumMemoryGapMs: 1001 }, { qualificationId: 'different' }]) {
    const operational = objectiveOperations(operations(), policy)
    if (!operational?.observations) throw new Error('Missing measured operations')
    expect(assessNumericObjective(policy, { ...evidence, operational: { ...operational, observations: { ...operational.observations, ...patch } } }, policy).status).toBe('insufficient_evidence')
  }
})
it('replaces worker-supplied operational evidence and rejects mismatched policies or missing comparisons', () => {
  const forged = report()
  for (const row of forged.objectiveAssessments) row.evidence.operational = { wallMs: 0, peakRssBytes: 0, maximumIngestionAgeMs: 0 }
  expect(finalizeObjectiveReport(forged, policy, null, policy).objectiveAssessments).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'insufficient_evidence', missingEvidence: ['operational_evidence_unavailable'] })]))
  expect(() => finalizeObjectiveReport(report(), { ...policy, minimumMaeImprovement: 3 }, operations(), policy)).toThrow('identity')
  expect(() => finalizeObjectiveReport({ objectiveAssessments: report().objectiveAssessments.slice(0, 1) }, policy, operations(), policy)).toThrow()
})

const metrics = ['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const
const policies = metrics.map(metric => ({ ...policy, metric }))
const multiReport = () => ({ objectiveAssessments: policies.flatMap(item => ['default', 'current'].map(baseline => ({
  baseline, candidate: 'candidate', baselineHash: baseline, candidateHash: 'candidate', ...assessNumericObjective(item, evidence, null),
}))) })

it('reassesses both baselines independently for all three numeric metrics', () => {
  const result = finalizeObjectiveReport(multiReport(), policies, operations(), policies)
  expect(result.objectiveAssessments).toHaveLength(6)
  for (const metric of metrics) {
    expect(result.objectiveAssessments).toEqual(expect.arrayContaining(['default', 'current'].map(baseline => expect.objectContaining({
      baseline, policy: expect.objectContaining({ metric }), status: 'improved', designated: true,
    }))))
  }
  const partial = finalizeObjectiveReport(multiReport(), policies, operations(), policies.slice(0, 2))
  expect(partial.objectiveAssessments).toEqual(expect.arrayContaining([expect.objectContaining({
    policy: expect.objectContaining({ metric: 'window_ibi_variability_v1' }), status: 'insufficient_evidence', missingEvidence: ['policy_not_designated'],
  })]))
})

it('rejects missing, duplicated, substituted or policy-mismatched metric/baseline pairs', () => {
  const source = multiReport()
  const rows = source.objectiveAssessments
  for (const objectiveAssessments of [rows.slice(1), [...rows, rows[0]], [rows[0], rows[0], ...rows.slice(2)],
    rows.map((row, index) => index === 5 ? { ...row, policy: { ...row.policy, minimumMaeImprovement: 3 } } : row)]) {
    expect(() => finalizeObjectiveReport({ objectiveAssessments }, policies, operations(), policies)).toThrow()
  }
  expect(() => finalizeObjectiveReport(source, [policies[0], policies[0], policies[2]], operations(), policies)).toThrow('Duplicate')
  expect(() => finalizeObjectiveReport(source, policies, operations(), [policies[0], policies[0]])).toThrow('Duplicate')
})

it('uses each metric policy for operational bounds and replaces child telemetry for every metric', () => {
  const strict = policies.map(item => item.metric === 'breathing_rate'
    ? { ...item, operational: { ...item.operational, maximumWallMs: 999 } }
    : item)
  const raw = { objectiveAssessments: strict.flatMap(item => ['default', 'current'].map(baseline => ({
    baseline, candidate: 'candidate', baselineHash: baseline, candidateHash: 'candidate',
    ...assessNumericObjective(item, { ...evidence, operational: { wallMs: 0, peakRssBytes: 0, maximumIngestionAgeMs: 0 } }, item),
  }))) }
  const result = finalizeObjectiveReport(raw, strict, operations(), strict)
  for (const row of result.objectiveAssessments as Array<{ policy: ObjectivePolicy, status: string, evidence: ObjectiveEvidence }>) {
    expect(row.evidence.operational?.wallMs).toBe(1000)
    expect(row.status).toBe(row.policy.metric === 'breathing_rate' ? 'regressed' : 'improved')
  }
})
