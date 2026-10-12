// @vitest-environment node
import { expect, it } from 'vitest'
import { backtestFixture } from './fixtures/backtest'
import { dataHash, configHash } from '../../algorithms/canonical'
import { evaluateBacktest } from '../evaluator'
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
