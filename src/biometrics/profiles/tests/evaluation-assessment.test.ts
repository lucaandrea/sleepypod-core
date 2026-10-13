import { replayContextFixture } from './fixtures/replay-context'
// @vitest-environment node
import { expect, it } from 'vitest'
import { verifyEvaluationAssessments } from '../evaluation-assessment'
import { evaluationFixture as fixture } from './fixtures/evaluation'
import { backtestFixture } from '../../backtest/tests/fixtures/backtest'
import { assessNumericObjective, type ObjectivePolicy, type ObjectiveEvidence } from '../../backtest/objective-policy'
import { configHash, dataHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'

it('reassesses exact retained evidence under a trusted policy and returns a bounded audit snapshot', () => {
  const work = fixture()
  expect(work.report.stageObjectiveAssessments[0].status).toBe('insufficient_evidence')
  const verified = verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)
  expect(verified).toMatchObject({ version: 'verified-evaluation-v1', reportHash: work.result().contentHash,
    changedDomains: ['sleep_stages'], numericAssessments: [], stageAssessments: [{ baseline: 'default', status: 'improved' }, { baseline: 'current', status: 'improved' }] })
  expect(verified).not.toHaveProperty('nights')
  expect(verified.policies).toEqual({ numeric: null, stages: work.designations.stages })
})

it('cannot promote a client-selected policy or trust claimed successful assessments', () => {
  const work = fixture()
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, { protocolHash: null, waveformContext: null, numeric: null, stages: null })).toThrow()
  work.report.stageObjectiveAssessments[0].status = 'improved'
  work.report.stageObjectiveAssessments[0].evidence.nights[0].candidateOutputCoverage = 0.5
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow()
})

it('requires both baseline comparisons and exact cohort membership even when scores pass', () => {
  for (const change of [
    (work: ReturnType<typeof fixture>) => { work.report.stageObjectiveAssessments.pop() },
    (work: ReturnType<typeof fixture>) => { work.report.stageObjectiveAssessments[0].baselineHash = '0'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.report.stageObjectiveAssessments[0].candidateHash = '0'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.report.stageObjectiveAssessments[0].evidence.nights[0].cohortId = 'other-night' },
  ]) {
    const work = fixture()
    change(work)
    expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow()
  }
  const incomplete = fixture()
  incomplete.report.nights.push({ cohortId: 'd' })
  incomplete.expected.dataset.holdoutCohortIds.push('d')
  expect(() => verifyEvaluationAssessments(incomplete.job, incomplete.result(), incomplete.expected, incomplete.designations)).toThrow('omits frozen')
})

it('requires an actual configuration change and a frozen stage policy', () => {
  const work = fixture()
  work.job.configs[2].resolved = defaultConfig
  work.job.configs[2].resolvedHash = configHash(defaultConfig)
  work.expected.resolvedHash = configHash(defaultConfig)
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow('does not change')
  const missing = fixture()
  const protocol = backtestFixture().job.protocol
  const job = { ...missing.job, protocol, protocolHash: configHash(protocol) }
  const report = { ...missing.report, protocol, protocolHash: job.protocolHash }
  expect(() => verifyEvaluationAssessments(job, { ...missing.result(), report, contentHash: dataHash(report) }, missing.expected, missing.designations)).toThrow('require stage objective')
})

it('rejects missing supervisor measurements and no material primary improvement', () => {
  const work = fixture()
  work.report.jobOperations.memory.allSamplesAvailable = false
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow()
  work.report.jobOperations.memory.allSamplesAvailable = true
  work.report.stageObjectiveAssessments[1].evidence.intervalLower = 0
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow('does not support')
})

it('does not let stage agreement validate a simultaneous numeric parameter change', () => {
  const work = fixture()
  const candidate = work.job.configs[2]
  candidate.resolved.heart_rate.trackingToleranceBpm = 20
  candidate.resolvedHash = configHash(candidate.resolved)
  work.expected.resolvedHash = candidate.resolvedHash
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow('numeric component')
})

it('requires numeric improvement while allowing unchanged downstream stages, and rejects an unassessed second metric', () => {
  const work = fixture()
  const policy: ObjectivePolicy = { version: 'numeric-objective-v1', qualificationId: work.designations.stages.qualificationId,
    metric: 'heart_rate', minimumNights: 3, minimumPairedReferencesPerNight: 1, maximumLostObservationFraction: 0.1,
    minimumMaeImprovement: 2, maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0.34,
    maximumSubgroupMaeRegression: 1, requiredSubgroups: [], operational: work.designations.stages.operational }
  const candidate = structuredClone(defaultConfig)
  candidate.heart_rate.trackingToleranceBpm = 20
  work.job.configs[2].resolved = candidate
  work.job.configs[2].resolvedHash = configHash(candidate)
  const protocol = { ...work.job.protocol, mode: 'signal_replay' as const, waveformStages: true, objectivePolicy: policy }
  const pythonBuildHash = 'a'.repeat(64), otherSideConfigHash = configHash(defaultConfig)
  const job = { ...work.job, protocol, protocolHash: configHash(protocol), waveform: { pythonBuildHash,
    otherSide: { resolved: defaultConfig, resolvedHash: otherSideConfigHash, manifestHash } } }
  const evidence: ObjectiveEvidence = { metricCompatible: true, split: 'holdout', holdoutUse: 1, intervalUpper: -2, subgroups: [], operational: null,
    nights: ['a', 'b', 'c'].map(cohortId => ({ cohortId, pairedReferences: 10, maeDifference: -2, baselineObservationCount: 10, lostObservations: 0 })) }
  const report = { ...work.report, protocol, protocolHash: job.protocolHash, version: 'waveform-backtest-report-v1',
    support: 'identical_retained_waveform_inputs', waveform: { pythonBuildHash, otherSideConfigHash,
      ...replayContextFixture(['a', 'b', 'c'], job.configs.map(row => row.resolvedHash), pythonBuildHash, otherSideConfigHash) },
    objectiveAssessments: ['default', 'current'].map(baseline => ({ baseline, candidate: 'candidate', baselineHash: configHash(defaultConfig),
      candidateHash: configHash(candidate), ...assessNumericObjective(policy, structuredClone(evidence), null) })) }
  for (const row of report.stageObjectiveAssessments) {
    row.candidateHash = configHash(candidate)
    row.evidence.intervalLower = 0
    for (const night of row.evidence.nights) night.agreementDifference = 0
  }
  const result = () => ({ report, contentHash: dataHash(report), available: true, currentHoldoutUseCount: 1 })
  const expected = { ...work.expected, resolvedHash: configHash(candidate), waveform: { pythonBuildHash, otherSideConfigHash } }
  const designations = { ...work.designations, protocolHash: job.protocolHash, waveformContext: { allowedLimitations: ['event_time_replaces_arrival_time' as const] }, numeric: policy }
  expect(verifyEvaluationAssessments(job, result(), expected, designations)).toMatchObject({ changedDomains: ['heart_rate'],
    numericAssessments: [{ status: 'improved' }, { status: 'improved' }], stageAssessments: [{ status: 'no_material_change' }, { status: 'no_material_change' }] })
  expect(verifyEvaluationAssessments(job, result(), expected, designations)).toMatchObject({ policies: { numeric: policy }, waveform: expected.waveform })
  report.objectiveAssessments[1].evidence.intervalUpper = 0
  expect(() => verifyEvaluationAssessments(job, result(), expected, designations)).toThrow('does not support')
  candidate.breathing_rate.intervalLowerRatio = 0.6
  job.configs[2].resolvedHash = configHash(candidate)
  expected.resolvedHash = configHash(candidate)
  expect(() => verifyEvaluationAssessments(job, result(), expected, designations)).toThrow('numeric component')

  const breathingPolicy: ObjectivePolicy = { ...policy, metric: 'breathing_rate' }
  const rest = { ...work.job.protocol, mode: protocol.mode, waveformStages: true }
  const multiProtocol = { ...rest, objectivePolicies: [policy, breathingPolicy] }
  const multiJob = { ...job, protocol: multiProtocol, protocolHash: configHash(multiProtocol) }
  const multiReport = { ...report, protocol: multiProtocol, protocolHash: multiJob.protocolHash,
    waveform: { pythonBuildHash, otherSideConfigHash, ...replayContextFixture(['a', 'b', 'c'], multiJob.configs.map(row => row.resolvedHash), pythonBuildHash, otherSideConfigHash) },
    stageObjectiveAssessments: report.stageObjectiveAssessments.map(row => ({ ...row, candidateHash: configHash(candidate) })),
    objectiveAssessments: multiProtocol.objectivePolicies.flatMap(item => ['default', 'current'].map(baseline => ({
      baseline, candidate: 'candidate', baselineHash: configHash(defaultConfig), candidateHash: configHash(candidate),
      ...assessNumericObjective(item, structuredClone(evidence), null),
    }))) }
  const multiResult = () => ({ ...result(), report: multiReport, contentHash: dataHash(multiReport) })
  const qualified = { ...designations, protocolHash: multiJob.protocolHash, numeric: multiProtocol.objectivePolicies }
  expect(verifyEvaluationAssessments(multiJob, multiResult(), expected, qualified)).toMatchObject({
    changedDomains: ['heart_rate', 'breathing_rate'], numericAssessments: [
      { metric: 'heart_rate', status: 'improved' }, { metric: 'heart_rate', status: 'improved' },
      { metric: 'breathing_rate', status: 'improved' }, { metric: 'breathing_rate', status: 'improved' },
    ],
  })
  expect(() => verifyEvaluationAssessments(multiJob, multiResult(), expected, designations)).toThrow()
  multiReport.objectiveAssessments[3].evidence.nights.pop()
  expect(() => verifyEvaluationAssessments(multiJob, multiResult(), expected, qualified)).toThrow()
})

it('does not transfer threshold qualification to changed alignment, calibration or uncertainty settings', () => {
  for (const patch of [
    { clockOffsetMs: 1000 },
    { pointToleranceMs: 1000 },
    { assumedStageCalibrationQuality: 0.75 },
    { nightUncertainty: { version: 'paired-night-percentile-v1' as const, seed: 'changed-seed', resamples: 200, minimumNights: 3 } },
  ]) {
    const work = fixture()
    const protocol = { ...work.job.protocol, ...patch }
    const job = { ...work.job, protocol, protocolHash: configHash(protocol) }
    const report = { ...work.report, protocol, protocolHash: job.protocolHash }
    const result = { ...work.result(), report, contentHash: dataHash(report) }
    expect(() => verifyEvaluationAssessments(job, result, work.expected, work.designations)).toThrow('qualified context')
    expect(verifyEvaluationAssessments(job, result, work.expected, { ...work.designations, protocolHash: job.protocolHash }))
      .toMatchObject({ protocolHash: job.protocolHash })
  }
  const work = fixture()
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, { ...work.designations, protocolHash: null }))
    .toThrow('qualified context')
})

it('derives aggregate status from reassessed evidence without accepting a claimed report status', async () => {
  const { assessEvaluation } = await import('../evaluation-assessment')
  const work = fixture()
  expect(assessEvaluation(work.job, work.result(), work.expected, work.designations).status).toBe('improved')
  work.report.stageObjectiveAssessments[0].status = 'improved'
  work.report.stageObjectiveAssessments[0].evidence.intervalLower = 0
  for (const night of work.report.stageObjectiveAssessments[0].evidence.nights) night.agreementDifference = 0
  expect(assessEvaluation(work.job, work.result(), work.expected, work.designations).status).toBe('no_material_change')
  work.report.stageObjectiveAssessments[0].evidence.nights[0].candidateOutputCoverage = 0.1
  expect(assessEvaluation(work.job, work.result(), work.expected, work.designations).status).toBe('regressed')
  work.report.jobOperations.memory.allSamplesAvailable = false
  expect(assessEvaluation(work.job, work.result(), work.expected, work.designations).status).toBe('insufficient_evidence')
  expect(() => verifyEvaluationAssessments(work.job, work.result(), work.expected, work.designations)).toThrow('does not support')
})
