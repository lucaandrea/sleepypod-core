import { z } from 'zod'
import { waveformReadingSchema, waveformRunSchema } from './waveform-output'
import { compareStageOutputs } from './stage-comparison'
import { createNightSummary } from './night-summary-core'
import { createNightUncertainty } from './uncertainty-core'
import { intersectOutputSupport } from './common-support'
import { classifySleepStages, type SleepStageBlock } from '@/src/lib/sleep-stages'
import { biometricManifest, validateConfig } from '../algorithms/registry-core'
import { alignReferences, DEFAULT_ALIGNMENT } from '../references/alignment'
import { scoreStageDurations } from '../references/stage-scoring'
import { datasetSnapshotSchema, enqueueBacktestSchema, experimentProtocolSchema } from './contracts'

export const waveformEvaluationSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), outputs: z.array(z.object({
  cohortId: z.string().min(1).max(200), configHash: z.string().regex(/^[a-f0-9]{64}$/),
  readings: z.array(waveformReadingSchema).max(20000), run: waveformRunSchema,
}).strict()).max(180) }).strict().refine(value => value.outputs.reduce((sum, output) => sum + output.readings.length, 0) <= 20000, 'Waveform reading budget exceeded')

export const backtestWorkSchema = z.object({
  job: enqueueBacktestSchema.extend({ version: z.literal('backtest-job-v1'), datasetId: z.string().uuid(),
    datasetHash: z.string(), protocol: experimentProtocolSchema, protocolHash: z.string(), holdoutUse: z.number().int().nonnegative(),
    evidence: z.enum(['descriptive_only', 'reused_holdout_is_validation']),
  }),
  dataset: z.object({ manifest: z.unknown(), snapshot: datasetSnapshotSchema }),
  waveform: waveformEvaluationSchema.optional(),
})
const assignmentsSchema = z.object({ splitProtocol: z.object({ assignments: z.array(z.object({
  cohortId: z.string(), sessionIds: z.array(z.number()), split: z.enum(['tuning', 'validation', 'holdout']), startMs: z.number(), endMs: z.number(),
})) }) })

function mergeWindows(windows: Array<{ startMs: number, endMs: number }>) {
  const merged: typeof windows = []
  for (const window of [...windows].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1)
    if (last && last.endMs >= window.startMs) last.endMs = Math.max(last.endMs, window.endMs)
    else merged.push({ ...window })
  }
  return merged
}

/** Pure retained-data evaluator. No DB, network, filesystem or hardware writes. */
export function createBacktestEvaluator(dependencies: { configHash: (value: unknown) => string, dataHash: (value: unknown) => string, digest: (text: string) => Uint8Array }) {
  const { configHash, dataHash, digest } = dependencies
  const manifestHash = configHash(biometricManifest)
  const summarizeStageNights = createNightSummary(createNightUncertainty(digest))
  return function evaluateBacktest(raw: z.input<typeof backtestWorkSchema>, progress: (completed: number, total: number) => void = () => {}) {
    const { job, dataset, waveform } = backtestWorkSchema.parse(raw)
    const signalReplay = job.protocol.mode === 'signal_replay'
    const stages = job.protocol.mode === 'stage_replay' || (signalReplay && job.protocol.waveformStages === true)
    if (dataHash(dataset) !== job.datasetHash || configHash(job.protocol) !== job.protocolHash) throw new Error('Evaluation input integrity mismatch')
    const assignments = assignmentsSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === job.split)
    if (!assignments.length) throw new Error('No nights in selected split')
    const configs = job.configs.map((config) => {
      const resolved = validateConfig(config.resolved)
      if (config.manifestHash !== manifestHash || configHash(resolved) !== config.resolvedHash) throw new Error('Evaluation engine/configuration mismatch')
      return { ...config, resolved }
    })
    const waveformOutputs = new Map<string, NonNullable<typeof waveform>['outputs'][number]>()
    if (signalReplay) {
      if (!job.waveform || !waveform || dataset.snapshot.version !== 'waveform-dataset-v1'
        || dataHash(waveform.outputs) !== waveform.hash) throw new Error('Missing or corrupt waveform evaluation inputs')
      const other = validateConfig(job.waveform.otherSide.resolved)
      if (job.waveform.otherSide.manifestHash !== manifestHash || configHash(other) !== job.waveform.otherSide.resolvedHash) throw new Error('Invalid other-side waveform configuration')
      const expectedConfigs = new Set(configs.map(config => config.resolvedHash))
      const otherSide = dataset.snapshot.side === 'left' ? 'right' : 'left'
      for (const output of waveform.outputs) {
        const retained = dataset.snapshot.waveformInputs.find(row => row.cohortId === output.cohortId)
        const key = `${output.cohortId}:${output.configHash}`
        if (!retained || !assignments.some(row => row.cohortId === output.cohortId) || !expectedConfigs.has(output.configHash)
          || waveformOutputs.has(key) || output.run.build_hash !== job.waveform.pythonBuildHash
          || output.run.config_hashes[dataset.snapshot.side] !== output.configHash
          || output.run.config_hashes[otherSide] !== job.waveform.otherSide.resolvedHash
          || output.run.counts.scored_outputs !== output.readings.length
          || output.run.raw_records < output.run.decoded_records || output.run.decoded_records < output.run.counts.records
          || JSON.stringify(output.run.artifact_hashes) !== JSON.stringify(retained.input.artifacts.map(row => row.artifact.sha256))
          || output.readings.some(row => row.configHash !== output.run.config_hashes[row.side]
            || row.timestampMs < retained.input.score_start_ms || row.timestampMs >= retained.input.score_end_ms)) throw new Error('Waveform output identity mismatch')
        waveformOutputs.set(key, output)
      }
      if (waveformOutputs.size !== assignments.length * expectedConfigs.size) throw new Error('Missing waveform cohort/configuration output')
    }
    else if (waveform || job.waveform) throw new Error('Unexpected waveform inputs for processed replay')
    const references = dataset.snapshot.references.flatMap(source => source.measurements.map(row => ({ ...row, recordKey: `${source.importId}:${row.recordKey}` })))
    const nights = assignments.map((assignment, nightIndex) => {
      const sessions = assignment.sessionIds.map((id) => {
        const session = dataset.snapshot.sessions.find(row => row.id === id)
        if (!session) throw new Error('Retained session missing')
        return session
      })
      const windows = mergeWindows(sessions.map(row => ({ startMs: row.startMs, endMs: row.endMs })))
      const vitals = [...new Map(sessions.flatMap(session => session.vitals).map(row => [row.id, row])).values()].sort((a, b) => a.timestampMs - b.timestampMs)
      const movement = [...new Map(sessions.flatMap(session => session.movement).map(row => [row.id, row])).values()].sort((a, b) => a.timestampMs - b.timestampMs || a.id - b.id)
      // Each unique configuration executes once even when default/current match.
      const computed = new Map<string, ReturnType<typeof evaluateConfig>>()
      const evaluateConfig = (config: typeof configs[number]) => windows.map((window) => {
        if (window.endMs - window.startMs > 86400000) throw new Error('Merged replay window exceeds the one-day evaluation budget')
        const output = waveformOutputs.get(`${assignment.cohortId}:${config.resolvedHash}`)
        const observations = signalReplay
          ? (output?.readings.filter(row => row.side === dataset.snapshot.side).map((row, id) => ({
              id, timestampMs: row.timestampMs, heartRate: row.heartRate, hrv: row.hrvIndex, breathingRate: row.breathingRate, processingRunId: null,
            })) ?? [])
          : vitals
        const rows = observations.filter(row => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)
        const moves = movement.filter(row => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)
        const numeric = (['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const).map((metric) => {
          const aligned = alignReferences(metric, metric === 'window_ibi_variability_v1' ? 300000 : null,
            rows.map(row => ({ timestampMs: row.timestampMs, value: metric === 'heart_rate' ? row.heartRate : metric === 'breathing_rate' ? row.breathingRate : row.hrv })),
            references.filter(row => row.metric === metric && row.startMs >= window.startMs && (row.temporalKind === 'point' ? row.startMs < window.endMs : row.endMs <= window.endMs)),
            { ...DEFAULT_ALIGNMENT, pointToleranceMs: job.protocol.pointToleranceMs, clockOffsetMs: job.protocol.clockOffsetMs })
          // The report stores summaries; full input samples remain in the dataset.
          return { metric, status: aligned.status, metrics: aligned.metrics, pairedCount: aligned.pairedCount,
            referenceCoverage: aligned.referenceCoverage, outputCoverage: aligned.outputCoverage, unmatchedReferences: aligned.unmatchedReferences,
            unmatchedObservations: aligned.unmatchedObservations, exclusions: aligned.exclusions }
        })
        let blocks: SleepStageBlock[] = []
        if (stages) {
          const epochs = classifySleepStages(rows.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })),
            moves.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })), job.protocol.assumedStageCalibrationQuality, config.resolved.sleep_stages.ruleset)
          blocks = epochs.map(epoch => ({ start: epoch.start, end: Math.min(window.endMs, epoch.start + epoch.duration), stage: epoch.stage })).filter(row => row.end > row.start)
        }
        return { ...window, observationCount: rows.length, numeric,
          stage: stages
            ? scoreStageDurations(blocks.map(block => ({ ...block, start: block.start + job.protocol.clockOffsetMs, end: block.end + job.protocol.clockOffsetMs })), references.filter(row => row.metric === 'sleep_stages'), window.startMs, window.endMs)
            : null,
          // Bounded complete traces (the dataset has at most 20k rows).
          blocks,
        }
      })
      const evaluations = configs.map((config) => {
        let windows = computed.get(config.resolvedHash)
        if (!windows) {
          windows = evaluateConfig(config)
          computed.set(config.resolvedHash, windows)
        }
        return { label: config.label, revisionId: config.revisionId, configHash: config.resolvedHash, windows }
      })
      const shift = (blocks: SleepStageBlock[]) => blocks.map(block => ({ ...block,
        start: block.start + job.protocol.clockOffsetMs, end: block.end + job.protocol.clockOffsetMs }))
      const sharedSupport = stages
        ? windows.map((window, index) =>
            intersectOutputSupport(evaluations.map(evaluation => shift(evaluation.windows[index].blocks)), window.startMs, window.endMs))
        : []
      const comparisons = stages
        ? evaluations.flatMap(candidate => evaluations
            .filter(baseline => (candidate.label === 'candidate' && baseline.label !== 'candidate') || (candidate.label === 'current' && baseline.label === 'default'))
            .map(baseline => ({ baseline: baseline.label, candidate: candidate.label,
              baselineHash: baseline.configHash, candidateHash: candidate.configHash,
              windows: candidate.windows.map((window, index) => {
                return { startMs: window.startMs, endMs: window.endMs,
                  ...compareStageOutputs(shift(baseline.windows[index].blocks), shift(window.blocks),
                    references.filter(row => row.metric === 'sleep_stages'), window.startMs, window.endMs, sharedSupport[index]) }
              }),
            })))
        : []
      progress(nightIndex + 1, assignments.length)
      return { cohortId: assignment.cohortId, sessionIds: assignment.sessionIds,
        uniqueObservationCount: signalReplay
          ? new Set([...waveformOutputs.values()].filter(output => output.cohortId === assignment.cohortId)
            .flatMap(output => output.readings.filter(row => row.side === dataset.snapshot.side
              && windows.some(window => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)).map(row => row.timestampMs))).size
          : vitals.length,
        ...(signalReplay ? { recordedObservationCount: vitals.length, observationCountBasis: 'union_of_derived_timestamps' } : {}), evaluations, comparisons }
    })
    return { version: signalReplay ? 'waveform-backtest-report-v1' as const : 'processed-backtest-report-v1' as const,
      ...(signalReplay ? { waveform: { ...(job.waveform?.baselineProvenance ? { baselineProvenance: job.waveform.baselineProvenance } : {}), pythonBuildHash: job.waveform?.pythonBuildHash, otherSideConfigHash: job.waveform?.otherSide.resolvedHash, ...waveform } } : {}), datasetId: job.datasetId, datasetHash: job.datasetHash,
      evaluatorBuildHash: job.evaluatorBuildHash, protocol: job.protocol, protocolHash: job.protocolHash, manifestHash, support: signalReplay ? 'identical_retained_waveform_inputs' as const : 'identical_retained_epoch_intervals' as const, split: job.split, holdoutUse: job.holdoutUse,
      status: 'insufficient_evidence' as const, evidence: job.evidence, nights, stageNightSummary: summarizeStageNights(nights, job.protocol.nightUncertainty),
      calibration: { source: 'explicit_assumption' as const, quality: job.protocol.assumedStageCalibrationQuality },
      limitations: ['This descriptive report does not establish validated improvement.',
        ...(signalReplay ? ['Numeric scores use each configuration’s available observations; unequal output coverage must not be interpreted as improvement.'] : []),
        signalReplay
          ? 'Numeric readings are replayed from retained waveforms; missing historical context, event-time substitution and cold starts constrain parity.'
          : 'Numeric readings are original observations; parameter changes to waveform processing are not evaluated by processed-data replay.',
        'Stages use the shared retrospective classifier, including its bounded gap-duration semantics; they are not causal predictions.',
        'Calibration quality is an explicit assumption, not recovered historical sensor calibration.',
        'Overlapping sessions share one input set; disconnected sessions are classified separately.',
        'Holdout exposure must be rechecked before any later promotion decision.'],
    }
  }
}
