import { stageObjectiveTestPolicy as policy } from './fixtures/stage-objective'
// @vitest-environment node
import { expect, it } from 'vitest'
import { assessStageObjective, type StageObjectiveEvidence } from '../stage-objective'
import { experimentProtocolSchema } from '../contracts'
import { configHash } from '../../algorithms/canonical'
import { finalizeStageObjectiveReport } from '../objective-finalization'
import { evaluateBacktest } from '../evaluator'
import { backtestFixture } from './fixtures/backtest'
const evidence = (): StageObjectiveEvidence => ({ split: 'holdout', holdoutUse: 1, intervalLower: 0.125,
  operational: { wallMs: 1000, peakRssBytes: 1000, maximumIngestionAgeMs: 1000 }, nights: ['a', 'b', 'c'].map(cohortId => ({
    cohortId, pairedDurationMs: 800, agreementDifference: 0.125, macroF1Difference: 0.125, candidateOutputCoverage: 0.9,
    baselineOutputMs: 1000, commonOutputMs: 900,
    perStage: policy.requiredStages.map(stage => ({ stage, referenceMs: 200, f1Difference: 0.125 })),
  })) })
it('awards reference agreement improvement only with designated independent supported evidence at exact boundaries', () => {
  expect(assessStageObjective(policy, evidence(), policy).status).toBe('improved')
  expect(assessStageObjective(policy, evidence(), null).missingEvidence).toEqual(['policy_not_designated'])
  for (const patch of [{ holdoutUse: 2 }, { split: 'validation' as const }, { intervalLower: null }, { operational: null }]) {
    expect(assessStageObjective(policy, { ...evidence(), ...patch }, policy).status).toBe('insufficient_evidence')
  }
  expect(assessStageObjective(policy, { ...evidence(), intervalLower: 0.124 }, policy).status).toBe('no_material_change')
})
it('does not hide coverage, macro-F1 or required-stage regressions behind improved overall agreement', () => {
  const data = evidence()
  data.nights[0].commonOutputMs = 899
  data.nights[0].candidateOutputCoverage = 0.89
  data.nights[0].macroF1Difference = -0.126
  data.nights[0].perStage[3].f1Difference = -0.126
  expect(assessStageObjective(policy, data, policy)).toMatchObject({ status: 'regressed', failedThresholds: ['output_coverage', 'coverage_loss', 'macro_f1_regression', 'stage_regression:rem'] })
})
it('requires supported stages on every night and bounds night-level regressions', () => {
  const data = evidence()
  data.nights[0].perStage[3].referenceMs--
  data.nights[0].pairedDurationMs--
  expect(assessStageObjective(policy, data, policy).missingEvidence).toContain('stage_support:rem')
  const regressed = evidence()
  regressed.nights[0].agreementDifference = -0.126
  regressed.nights[1].agreementDifference = -0.01
  expect(assessStageObjective(policy, regressed, policy).failedThresholds).toEqual(['night_regression', 'regressed_night_fraction'])
})
it('rejects duplicate or inconsistent support and freezes stage thresholds only with stage replay', () => {
  const data = evidence()
  data.nights.push(data.nights[0])
  expect(() => assessStageObjective(policy, data, policy)).toThrow('evidence')
  const invalid = evidence()
  invalid.nights[0].commonOutputMs = 1001
  expect(() => assessStageObjective(policy, invalid, policy)).toThrow('evidence')
  const protocol = { ...backtestFixture().job.protocol, stageObjectivePolicy: policy }
  expect(experimentProtocolSchema.safeParse(protocol).success).toBe(true)
  expect(experimentProtocolSchema.safeParse({ ...protocol, mode: 'comparison' }).success).toBe(false)
  expect(experimentProtocolSchema.safeParse({ ...protocol, mode: 'signal_replay', waveformStages: false }).success).toBe(false)
  expect(configHash(protocol)).not.toBe(configHash({ ...protocol, stageObjectivePolicy: { ...policy, minimumAgreementImprovement: 0.25 } }))
})
it('scores stage evidence in retained replay and replaces claimed operational evidence at publication', () => {
  const work = backtestFixture()
  const protocol = { ...work.job.protocol, stageObjectivePolicy: policy }
  const report = evaluateBacktest({ ...work, job: { ...work.job, protocol, protocolHash: configHash(protocol),
    configs: [...work.job.configs, { ...work.job.configs[0], label: 'candidate' }] } })
  expect(report.stageObjectiveAssessments).toHaveLength(2)
  expect(report.stageObjectiveAssessments[0]).toMatchObject({ status: 'insufficient_evidence', designated: false,
    evidence: { nights: [{ cohortId: 'night', commonOutputMs: 600000 }], operational: null } })
  const claimed = { stageObjectiveAssessments: ['default', 'current'].map(baseline => ({ baseline, candidate: 'candidate', baselineHash: baseline, candidateHash: 'candidate',
    ...assessStageObjective(policy, evidence(), policy) })) }
  expect(finalizeStageObjectiveReport(claimed, policy, null, policy).stageObjectiveAssessments).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'insufficient_evidence', missingEvidence: ['operational_evidence_unavailable'] })]))
})

it('retains specific missing evidence for sparse nights and unavailable metrics', () => {
  const cases: [string, (data: StageObjectiveEvidence) => void][] = [
    ['independent_holdout_required', (data) => { data.holdoutUse = 2 }],
    ['uncertainty_unavailable', (data) => { data.intervalLower = null }],
    ['coverage_unavailable', (data) => { data.nights[0].candidateOutputCoverage = null }],
    ['macro_f1_unavailable', (data) => { data.nights[0].macroF1Difference = null }],
    ['stage_support:rem', (data) => { data.nights[0].perStage[3].f1Difference = null }],
  ]
  for (const [reason, change] of cases) {
    const data = evidence()
    change(data)
    expect(assessStageObjective(policy, data, policy)).toMatchObject({ status: 'insufficient_evidence', missingEvidence: [reason], failedThresholds: [] })
  }
  for (const change of [
    (data: StageObjectiveEvidence) => { data.nights[0].agreementDifference = null },
    (data: StageObjectiveEvidence) => {
      data.nights[0].pairedDurationMs--
      data.nights[0].perStage[0].referenceMs--
    },
  ]) {
    const data = evidence()
    change(data)
    expect(assessStageObjective(policy, data, policy).missingEvidence).toEqual(expect.arrayContaining(['insufficient_supported_nights', 'unsupported_nights']))
  }
  const empty = evidence()
  empty.nights = []
  expect(assessStageObjective(policy, empty, policy)).toMatchObject({ status: 'insufficient_evidence', equalNightMeanAgreementDifference: null, missingEvidence: ['insufficient_supported_nights'] })
})

it('requires actual mean improvement and preserves inclusive regression limits', () => {
  const data = evidence()
  data.nights[0].agreementDifference = -0.125
  data.nights[1].agreementDifference = 0
  data.nights[2].agreementDifference = 0.5
  data.nights[0].macroF1Difference = -0.125
  data.nights[0].perStage[3].f1Difference = -0.125
  const exact = { ...policy, maximumRegressedNightFraction: 1 / 3 }
  expect(assessStageObjective(exact, data, exact)).toMatchObject({ status: 'improved', failedThresholds: [], equalNightMeanAgreementDifference: 0.125 })
  data.nights[2].agreementDifference = 0.499
  expect(assessStageObjective(exact, data, exact).status).toBe('no_material_change')
})

it('rejects duplicated stages, inconsistent paired durations, and altered designation', () => {
  const duplicate = evidence()
  duplicate.nights[0].perStage[3].stage = 'wake'
  expect(() => assessStageObjective(policy, duplicate, policy)).toThrow('Invalid stage objective evidence')
  const unpaired = evidence()
  unpaired.nights[0].commonOutputMs = 799
  expect(() => assessStageObjective(policy, unpaired, policy)).toThrow('Invalid stage objective evidence')
  const mismatch = evidence()
  mismatch.nights[0].perStage[0].referenceMs++
  expect(() => assessStageObjective(policy, mismatch, policy)).toThrow('Invalid stage objective evidence')
  expect(() => assessStageObjective({ ...policy, requiredStages: ['wake', 'wake'] }, evidence(), policy)).toThrow('Duplicate required stages')
  expect(assessStageObjective(policy, evidence(), { ...policy, qualificationId: 'other' }).missingEvidence).toEqual(['policy_not_designated'])
})

it('reports absent stage support and zero baseline coverage without inventing a score', () => {
  const data = evidence()
  data.nights[0].baselineOutputMs = 0
  data.nights[0].commonOutputMs = 0
  data.nights[0].pairedDurationMs = 0
  data.nights[0].agreementDifference = null
  data.nights[0].macroF1Difference = null
  data.nights[0].perStage = []
  expect(assessStageObjective(policy, data, policy)).toMatchObject({ status: 'insufficient_evidence', failedThresholds: [],
    missingEvidence: ['insufficient_supported_nights', 'unsupported_nights', 'coverage_unavailable', 'macro_f1_unavailable',
      'stage_support:wake', 'stage_support:light', 'stage_support:deep', 'stage_support:rem'] })
})
