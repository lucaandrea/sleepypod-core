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
