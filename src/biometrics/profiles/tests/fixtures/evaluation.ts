import type { EvaluationIdentityExpectation } from '../../evaluation-identity'
import { stageObjectiveTestPolicy } from '../../../backtest/tests/fixtures/stage-objective'
import { backtestFixture } from '../../../backtest/tests/fixtures/backtest'
import { assessStageObjective, type StageObjectiveEvidence } from '../../../backtest/stage-objective'
import { configHash, dataHash } from '../../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../../algorithms/registry'

export function evaluationFixture() {
  const source = backtestFixture()
  const policy = { ...stageObjectiveTestPolicy, operational: { ...stageObjectiveTestPolicy.operational,
    observations: { version: 'sampled-process-group-v1' as const, maximumMemoryGapMs: 1000, maximumIngestionGapMs: 5000 } } }
  const candidate = structuredClone(defaultConfig)
  candidate.sleep_stages.ruleset.smoothIsolatedEpochs = false
  const revisionId = '33333333-3333-4333-8333-333333333333'
  const protocol = { ...source.job.protocol, stageObjectivePolicy: policy }
  const job = { ...source.job, protocol, protocolHash: configHash(protocol), split: 'holdout' as const, holdoutUse: 1,
    configs: [...source.job.configs, { label: 'candidate' as const, revisionId, resolved: candidate, resolvedHash: configHash(candidate), manifestHash }] }
  const evidence: StageObjectiveEvidence = { split: 'holdout', holdoutUse: 1, intervalLower: 0.125, operational: null,
    nights: ['a', 'b', 'c'].map(cohortId => ({ cohortId, pairedDurationMs: 800, agreementDifference: 0.125, macroF1Difference: 0.125,
      candidateOutputCoverage: 0.9, baselineOutputMs: 1000, commonOutputMs: 900,
      perStage: policy.requiredStages.map(stage => ({ stage, referenceMs: 200, f1Difference: 0.125 })) })) }
  const report = { version: 'processed-backtest-report-v1', side: 'left', datasetId: job.datasetId, datasetHash: job.datasetHash,
    protocol, protocolHash: job.protocolHash, evaluatorBuildHash: job.evaluatorBuildHash, manifestHash,
    split: 'holdout', holdoutUse: 1, support: 'identical_retained_epoch_intervals', nights: evidence.nights.map(row => ({ cohortId: row.cohortId })),
    stageObjectiveAssessments: ['default', 'current'].map(baseline => ({ baseline, candidate: 'candidate', baselineHash: configHash(defaultConfig),
      candidateHash: configHash(candidate), ...assessStageObjective(policy, structuredClone(evidence), null) })),
    jobOperations: { version: 'backtest-job-operations-v1', wallMs: 1000, scope: 'admission_through_prepublication',
      memory: { version: 'process-group-rss-observations-v1', scope: 'sum_rss_of_replay_process_group', attempts: 3, samples: 3,
        allSamplesAvailable: true, peakObservedRssBytes: 1000, maximumObservationGapMs: 1000, intervalMs: 1000, exactKernelPeak: false },
      ingestion: { source: 'supervisor_live_piezo_receipt_age', checks: 2, samples: 2, allChecksMeasured: true, qualificationId: policy.qualificationId,
        maximumObservedAgeMs: 1000, maximumObservationGapMs: 5000, nominalIntervalMs: 5000, continuousMeasurement: false } } }
  const expected: EvaluationIdentityExpectation = { side: 'left', revisionId, resolvedHash: configHash(candidate),
    currentResolvedHash: configHash(defaultConfig), evaluatorBuildHash: job.evaluatorBuildHash,
    dataset: { id: job.datasetId, contentHash: job.datasetHash, side: 'left', available: true, holdoutCohortIds: ['a', 'b', 'c'] } }
  const result = () => ({ report, contentHash: dataHash(report), available: true, currentHoldoutUseCount: 1 })
  const designations = { protocolHash: job.protocolHash, waveformContext: null, numeric: null, stages: policy }
  return { job, report, result, expected, designations }
}

