// @vitest-environment node
import { expect, it } from 'vitest'
import { verifyEvaluationIdentity, type EvaluationIdentityExpectation } from '../evaluation-identity'
import { backtestFixture } from '../../backtest/tests/fixtures/backtest'
import { configHash, dataHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'

function fixture() {
  const source = backtestFixture()
  const candidate = { ...defaultConfig, heart_rate: { ...defaultConfig.heart_rate, trackingToleranceBpm: 20 } }
  const revisionId = '33333333-3333-4333-8333-333333333333'
  const job = { ...source.job, split: 'holdout' as const, holdoutUse: 1, configs: [...source.job.configs,
    { label: 'candidate' as const, revisionId, resolved: candidate, resolvedHash: configHash(candidate), manifestHash }] }
  const report = { version: 'processed-backtest-report-v1', side: 'left', datasetId: job.datasetId, datasetHash: job.datasetHash,
    protocol: job.protocol, protocolHash: job.protocolHash, evaluatorBuildHash: job.evaluatorBuildHash, manifestHash,
    split: 'holdout', holdoutUse: 1, support: 'identical_retained_epoch_intervals', nights: [{ cohortId: 'night' }] }
  const expected: EvaluationIdentityExpectation = { side: 'left', revisionId, resolvedHash: configHash(candidate),
    currentResolvedHash: configHash(defaultConfig), evaluatorBuildHash: job.evaluatorBuildHash,
    dataset: { id: job.datasetId, contentHash: job.datasetHash, side: 'left', available: true, holdoutCohortIds: ['night'] } }
  const result = { report, contentHash: dataHash(report), available: true, currentHoldoutUseCount: 1 }
  return { job, report, expected, result }
}

it('binds retained report bytes to all three configurations without awarding activation', () => {
  const work = fixture()
  expect(verifyEvaluationIdentity(work.job, work.result, work.expected)).toMatchObject({ contentHash: work.result.contentHash, cohortIds: ['night'] })
  expect(verifyEvaluationIdentity(work.job, work.result, work.expected)).not.toHaveProperty('status')
})

it('rejects unavailable or changed artifacts and reused holdout evidence', () => {
  for (const patch of [{ available: false }, { contentHash: '0'.repeat(64) }, { currentHoldoutUseCount: 2 }]) {
    const work = fixture()
    expect(() => verifyEvaluationIdentity(work.job, { ...work.result, ...patch }, work.expected)).toThrow()
  }
  const work = fixture()
  expect(() => verifyEvaluationIdentity(work.job, work.result, { ...work.expected, dataset: { ...work.expected.dataset, available: false } })).toThrow('unavailable')
  expect(() => verifyEvaluationIdentity({ ...work.job, split: 'validation' }, work.result, work.expected)).toThrow('holdout')
  expect(() => verifyEvaluationIdentity({ ...work.job, holdoutUse: 2 }, work.result, work.expected)).toThrow('holdout')
})

it('rejects another revision, baseline, build, side, or frozen dataset even with matching report bytes', () => {
  const work = fixture()
  for (const patch of [{ revisionId: '44444444-4444-4444-8444-444444444444' }, { resolvedHash: '0'.repeat(64) },
    { currentResolvedHash: '0'.repeat(64) }, { evaluatorBuildHash: '0'.repeat(64) }, { side: 'right' as const },
    { dataset: { ...work.expected.dataset, contentHash: '0'.repeat(64) } }]) {
    expect(() => verifyEvaluationIdentity(work.job, work.result, { ...work.expected, ...patch })).toThrow()
  }
})

it('requires all exact frozen cohorts, a replay protocol, and matching protocol contents', () => {
  const work = fixture()
  for (const nights of [[], [{ cohortId: 'night' }, { cohortId: 'night' }], [{ cohortId: 'other' }]]) {
    const report = { ...work.report, nights }
    expect(() => verifyEvaluationIdentity(work.job, { ...work.result, report, contentHash: dataHash(report) }, work.expected)).toThrow()
  }
  const protocol = { ...work.job.protocol, clockOffsetMs: 1000 }
  const report = { ...work.report, protocol }
  expect(() => verifyEvaluationIdentity(work.job, { ...work.result, report, contentHash: dataHash(report) }, work.expected)).toThrow('protocol')
  const comparison = { ...work.job.protocol, mode: 'comparison' as const }
  const comparisonReport = { ...work.report, protocol: comparison, protocolHash: configHash(comparison) }
  expect(() => verifyEvaluationIdentity({ ...work.job, protocol: comparison, protocolHash: configHash(comparison) },
    { ...work.result, report: comparisonReport, contentHash: dataHash(comparisonReport) }, work.expected)).toThrow('mode')
})

it('checks independently altered job and report identities, not only their content hashes', () => {
  const work = fixture()
  const otherId = '44444444-4444-4444-8444-444444444444'
  for (const patch of [{ side: 'right' }, { datasetId: otherId }, { datasetHash: '0'.repeat(64) },
    { evaluatorBuildHash: '0'.repeat(64) }, { manifestHash: '0'.repeat(64) }, { protocolHash: '0'.repeat(64) },
    { support: 'identical_retained_waveform_inputs' }, { version: 'waveform-backtest-report-v1' }]) {
    const report = { ...work.report, ...patch }
    expect(() => verifyEvaluationIdentity(work.job, { ...work.result, report, contentHash: dataHash(report) }, work.expected)).toThrow()
  }
  for (const patch of [{ datasetId: otherId }, { datasetHash: '0'.repeat(64) }, { protocolHash: '0'.repeat(64) },
    { evidence: 'reused_holdout_is_validation' }]) {
    expect(() => verifyEvaluationIdentity({ ...work.job, ...patch }, work.result, work.expected)).toThrow()
  }
  expect(() => verifyEvaluationIdentity(work.job, work.result, { ...work.expected, dataset: { ...work.expected.dataset, side: 'right' } })).toThrow('side changed')
  for (const holdoutCohortIds of [['night', 'night'], ['night', 'missing']]) {
    expect(() => verifyEvaluationIdentity(work.job, work.result, { ...work.expected, dataset: { ...work.expected.dataset, holdoutCohortIds } })).toThrow('exact frozen')
  }
})

it('does not let mutually consistent replacements bypass the service expectations', () => {
  const work = fixture()
  const otherId = '44444444-4444-4444-8444-444444444444'
  const report = { ...work.report, datasetId: otherId }
  expect(() => verifyEvaluationIdentity({ ...work.job, datasetId: otherId },
    { ...work.result, report, contentHash: dataHash(report) }, work.expected)).toThrow('dataset')
  expect(() => verifyEvaluationIdentity({ ...work.job, protocol: { ...work.job.protocol, clockOffsetMs: 1 } }, work.result, work.expected)).toThrow('protocol')
  const configs = work.job.configs.map(row => row.label === 'current' ? { ...row, resolvedHash: '0'.repeat(64) } : row)
  expect(() => verifyEvaluationIdentity({ ...work.job, configs }, work.result, { ...work.expected, currentResolvedHash: '0'.repeat(64) })).toThrow('configuration identity')
  const expected = { ...work.expected, dataset: { ...work.expected.dataset, holdoutCohortIds: ['night', 'second'] } }
  for (const cohortIds of [['night', 'other'], ['night', 'night']]) {
    const altered = { ...work.report, nights: cohortIds.map(cohortId => ({ cohortId })) }
    expect(() => verifyEvaluationIdentity(work.job, { ...work.result, report: altered, contentHash: dataHash(altered) }, expected)).toThrow('exact frozen')
  }
})

it('rejects mislabeled defaults, duplicated baseline labels and changed resolved snapshots', () => {
  const work = fixture()
  const [baseline, current, candidate] = work.job.configs
  for (const configs of [[baseline, candidate], [baseline, baseline, candidate],
    [{ ...candidate, label: 'default', revisionId: null }, current, candidate],
    [{ ...baseline, revisionId: candidate.revisionId }, current, candidate],
    [{ ...baseline, manifestHash: '0'.repeat(64) }, current, candidate],
    [{ ...baseline, resolvedHash: '0'.repeat(64) }, current, candidate]]) {
    expect(() => verifyEvaluationIdentity({ ...work.job, configs }, work.result, work.expected)).toThrow()
  }
})

it('pins waveform Python and cross-side dependencies separately from the scoring build', () => {
  const work = fixture()
  const protocol = { ...work.job.protocol, mode: 'signal_replay' as const }
  const pythonBuildHash = 'a'.repeat(64), otherSideConfigHash = configHash(defaultConfig)
  const job = { ...work.job, protocol, protocolHash: configHash(protocol), waveform: { pythonBuildHash,
    otherSide: { resolved: defaultConfig, resolvedHash: otherSideConfigHash, manifestHash } } }
  const report = { ...work.report, version: 'waveform-backtest-report-v1', support: 'identical_retained_waveform_inputs',
    protocol, protocolHash: job.protocolHash, waveform: { pythonBuildHash, otherSideConfigHash } }
  const result = { ...work.result, report, contentHash: dataHash(report) }
  const expected = { ...work.expected, waveform: { pythonBuildHash, otherSideConfigHash } }
  expect(verifyEvaluationIdentity(job, result, expected).contentHash).toBe(result.contentHash)
  expect(() => verifyEvaluationIdentity(job, result, work.expected)).toThrow('Waveform')
  for (const waveform of [{ ...expected.waveform, pythonBuildHash: 'b'.repeat(64) }, { ...expected.waveform, otherSideConfigHash: 'b'.repeat(64) }]) {
    expect(() => verifyEvaluationIdentity(job, result, { ...expected, waveform })).toThrow('Waveform')
  }
  for (const waveform of [{ ...report.waveform, pythonBuildHash: 'b'.repeat(64) }, { ...report.waveform, otherSideConfigHash: 'b'.repeat(64) }]) {
    const altered = { ...report, waveform }
    expect(() => verifyEvaluationIdentity(job, { ...result, report: altered, contentHash: dataHash(altered) }, expected)).toThrow('Waveform')
  }
  for (const otherSide of [{ ...job.waveform.otherSide, manifestHash: 'b'.repeat(64) },
    { ...job.waveform.otherSide, resolved: work.job.configs[2].resolved }]) {
    expect(() => verifyEvaluationIdentity({ ...job, waveform: { ...job.waveform, otherSide } }, result, expected)).toThrow('Waveform')
  }
})
