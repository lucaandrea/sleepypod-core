import { previewReferenceImport } from '../../references/normalize'
// @vitest-environment node
import { expect, it } from 'vitest'
import { backtestFixture } from './fixtures/backtest'
import { dataHash, configHash } from '../../algorithms/canonical'
import { evaluateBacktest } from '../evaluator'
import { summarizeBacktestResult } from '../report-summary'
import { defaultConfig, manifestHash } from '../../algorithms/registry'

function fixture() {
  const base = backtestFixture()
  const cohort = base.dataset.manifest.splitProtocol.assignments[0]
  const digest = 'a'.repeat(64), build = 'b'.repeat(64), resolvedHash = configHash(defaultConfig)
  const dataset = { ...base.dataset, snapshot: { ...base.dataset.snapshot, version: 'waveform-dataset-v1' as const,
    waveformInputs: [{ cohortId: cohort.cohortId, input: { version: 'retained-waveform-input-v1' as const,
      retained_start_ms: cohort.startMs, score_start_ms: cohort.startMs, score_end_ms: cohort.endMs, contexts: [],
      artifacts: [{ artifact: { sha256: digest, name: `${digest}.RAW.gz`, compressed_bytes: 1, expanded_bytes: 2 },
        first_event_ms: cohort.startMs, last_event_ms: cohort.endMs - 1 }] } }] } }
  const protocol = { ...base.job.protocol, mode: 'signal_replay' as const, waveformStages: false }
  const readings = [{ side: 'left' as const, timestampMs: cohort.startMs, heartRate: 62, hrvIndex: null,
    hrvMetric: 'window_ibi_variability_v1' as const, breathingRate: 12, qualityScore: 1, flags: [], hrRaw: 62,
    sourceSide: 'left' as const, configHash: resolvedHash, limitations: ['unknown_context'] }]
  const outputs = [{ cohortId: cohort.cohortId, configHash: resolvedHash, readings, run: {
    version: 'retained-waveform-run-v1' as const, build_hash: build, decoded_records: 1, raw_records: 1,
    counts: { records: 1, accepted_frames: 1, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: 1 },
    limitations: ['unknown_context'], config_hashes: { left: resolvedHash, right: resolvedHash }, artifact_hashes: [digest],
  } }]
  return { dataset, job: { ...base.job, datasetHash: dataHash(dataset), protocol, protocolHash: configHash(protocol),
    waveform: { pythonBuildHash: build, otherSide: { manifestHash, resolvedHash, resolved: defaultConfig } } },
  waveform: { hash: dataHash(outputs), outputs } }
}
it('scores derived readings for matching labels without replacing immutable dataset identity', () => {
  const work = fixture()
  const before = structuredClone(work)
  const report = evaluateBacktest(work)
  expect(report.version).toBe('waveform-backtest-report-v1')
  expect(report.datasetHash).toBe(work.job.datasetHash)
  expect(report.nights[0].uniqueObservationCount).toBe(1)
  expect(report.nights[0].evaluations[0].windows[0].observationCount).toBe(1)
  expect(report.nights[0].evaluations[0].windows[0].numeric[0]).toMatchObject({ pairedCount: 1, metrics: { mae: 0 } })
  expect(report.nights[0].evaluations[1].windows).toEqual(report.nights[0].evaluations[0].windows)
  expect(report.nights[0].evaluations[0].windows[0].blocks).toEqual([])
  expect(report.nights[0].numericComparisons?.[0].metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ metric: 'heart_rate', baseline: 'default', candidate: 'current',
      commonObservationCount: 1, differences: expect.objectContaining({ commonMae: 0 }), coverageReduced: false }),
  ]))
  const summary = summarizeBacktestResult({ available: true, report })
  expect(summary?.report).toMatchObject({ nights: [expect.objectContaining({ numericComparisons: report.nights[0].numericComparisons })] })
  expect(report.numericNightSummary?.[0]).toMatchObject({ metric: 'heart_rate', scoredNights: 1, equalNightMeanMaeDifference: 0, uncertainty: { statistic: 'equal_night_mean_common_mae_difference', status: 'not_requested' } })
  expect(work).toEqual(before)
})
it('rejects incomplete, mismatched or extraneous derived waveform evidence', () => {
  for (const mutate of [
    (work: ReturnType<typeof fixture>) => { work.waveform.hash = '0'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs = [] },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs.push(structuredClone(work.waveform.outputs[0])) },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs[0].run.build_hash = '0'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs[0].run.config_hashes.right = '0'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs[0].run.artifact_hashes = ['0'.repeat(64)] },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs[0].readings[0].timestampMs-- },
    (work: ReturnType<typeof fixture>) => { work.waveform.outputs[0].readings[0].configHash = '0'.repeat(64) },
  ]) {
    const work = fixture()
    mutate(work)
    if (work.waveform.hash !== '0'.repeat(64)) work.waveform.hash = dataHash(work.waveform.outputs)
    expect(() => evaluateBacktest(work)).toThrow()
  }
})
it('rejects waveform evidence supplied to processed evaluation and missing evidence in signal replay', () => {
  expect(() => evaluateBacktest({ ...backtestFixture(), waveform: fixture().waveform })).toThrow('Unexpected waveform')
  const work = fixture()
  expect(() => evaluateBacktest({ ...work, waveform: undefined })).toThrow('Missing or corrupt')
})

it('retains objective thresholds but cannot promote without qualified measured evidence', () => {
  const work = fixture()
  const protocol = { ...work.job.protocol, objectivePolicy: { version: 'numeric-objective-v1' as const, qualificationId: 'test-only', metric: 'heart_rate' as const,
    minimumNights: 3, minimumPairedReferencesPerNight: 10, maximumLostObservationFraction: 0, minimumMaeImprovement: 2,
    maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0, maximumSubgroupMaeRegression: 1, requiredSubgroups: [],
    operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } } }
  const report = evaluateBacktest({ ...work, job: { ...work.job, protocol, protocolHash: configHash(protocol),
    configs: [...work.job.configs, { ...work.job.configs[0], label: 'candidate' }] } })
  expect(report.objectiveAssessments).toHaveLength(2)
  expect(report.objectiveAssessments[0]).toMatchObject({ status: 'insufficient_evidence', designated: false,
    missingEvidence: expect.arrayContaining(['policy_not_designated', 'operational_evidence_unavailable']) })
  expect(report.protocol.objectivePolicy).toEqual(protocol.objectivePolicy)
})

it('retains measured waveform costs through compact report projection without claiming whole-job health', () => {
  const work = fixture()
  const outputs = work.waveform.outputs.map(output => ({ ...output, run: { ...output.run, resources: {
    version: 'waveform-process-resources-v1' as const, wallMs: 120, cpuMs: 80, peakRssBytes: 102400,
    scope: 'python_process_until_result' as const, memoryScope: 'process_lifetime_high_water_mark' as const,
  } } }))
  const report = evaluateBacktest({ ...work, waveform: { hash: dataHash(outputs), outputs } })
  const summary = summarizeBacktestResult({ available: true, report })
  expect(summary?.report).toMatchObject({ waveform: { resources: {
    expectedProcesses: outputs.length, measuredProcesses: outputs.length, totalWallMs: outputs.length * 120,
    totalCpuMs: outputs.length * 80, largestProcessPeakRssBytes: 102400, ingestionHealthMeasured: false,
  } } })
})

it('exposes a late-window regression hidden by lower whole-night error', () => {
  const work = fixture(), start = work.dataset.snapshot.sessions[0].startMs
  const baseline = work.waveform.outputs[0]
  baseline.readings = [80, 60].map((heartRate, index) => ({ ...baseline.readings[0], heartRate, timestampMs: start + index * 300000 }))
  baseline.run.counts.scored_outputs = 2
  const candidate = structuredClone(defaultConfig)
  candidate.heart_rate.trackingToleranceBpm = 20
  const candidateHash = configHash(candidate)
  const output = { ...baseline, configHash: candidateHash,
    readings: baseline.readings.map((row, index) => ({ ...row, heartRate: index ? 65 : 60, configHash: candidateHash })),
    run: { ...baseline.run, config_hashes: { ...baseline.run.config_hashes, left: candidateHash } } }
  work.dataset.snapshot.references[0].measurements = previewReferenceImport({ side: 'left', source: 'fixture', subjectId: 'A', rows: [
    { recordKey: 'early', metric: 'heart_rate', timestampMs: start, value: 60, unit: 'bpm' },
    { recordKey: 'late', metric: 'heart_rate', timestampMs: start + 300000, value: 60, unit: 'bpm' },
  ] }).measurements
  const protocol = { ...work.job.protocol, objectivePolicy: { version: 'numeric-objective-v1' as const, qualificationId: 'test-only', metric: 'heart_rate' as const,
    minimumNights: 3, minimumPairedReferencesPerNight: 1, maximumLostObservationFraction: 0, minimumMaeImprovement: 2,
    maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0, maximumSubgroupMaeRegression: 1, requiredSubgroups: ['window_second_half'],
    operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } } }
  const outputs = [baseline, output]
  const report = evaluateBacktest({ ...work, waveform: { outputs, hash: dataHash(outputs) }, job: { ...work.job,
    datasetHash: dataHash(work.dataset), protocol, protocolHash: configHash(protocol),
    configs: [...work.job.configs, { ...work.job.configs[0], label: 'candidate', resolved: candidate, resolvedHash: candidateHash }] } })
  expect(report.numericNightSummary?.find(row => row.baseline === 'default' && row.candidate === 'candidate' && row.metric === 'heart_rate')?.equalNightMeanMaeDifference).toBe(-7.5)
  expect(report.numericSubgroupSummary?.find(row => row.name === 'window_second_half' && row.summary.baseline === 'default' && row.summary.candidate === 'candidate')?.summary.equalNightMeanMaeDifference).toBe(5)
  expect(report.objectiveAssessments[0].evidence.subgroups).toContainEqual({ name: 'window_second_half', pairedNights: 1, maeDifference: 5 })
  expect(report.objectiveAssessments[0].evidence.subgroups).toContainEqual({ name: 'reference_intervals', pairedNights: 0, maeDifference: null })
})

it('evaluates each numeric policy against both baselines without mixing metric subgroups', () => {
  const work = fixture()
  const objectivePolicies = (['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const).map(metric => ({
    version: 'numeric-objective-v1' as const, qualificationId: 'multi-test', metric, minimumNights: 3,
    minimumPairedReferencesPerNight: 1, maximumLostObservationFraction: 0, minimumMaeImprovement: 1,
    maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0, maximumSubgroupMaeRegression: 1,
    requiredSubgroups: ['reference_points'], operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 },
  }))
  const protocol = { ...work.job.protocol, objectivePolicies }
  const report = evaluateBacktest({ ...work, job: { ...work.job, protocol, protocolHash: configHash(protocol),
    configs: [...work.job.configs, { ...work.job.configs[0], label: 'candidate' }] } })
  expect(report.objectiveAssessments).toHaveLength(6)
  for (const policy of objectivePolicies) {
    const assessments = report.objectiveAssessments.filter(row => row.policy.metric === policy.metric)
    expect(assessments.map(row => row.baseline).sort()).toEqual(['current', 'default'])
    expect(assessments.every(row => row.status === 'insufficient_evidence' && !row.designated)).toBe(true)
    expect(report.numericSubgroupSummary?.filter(row => row.summary.metric === policy.metric)).toHaveLength(12)
  }
})
