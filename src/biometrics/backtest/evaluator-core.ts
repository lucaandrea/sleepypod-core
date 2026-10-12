import { z } from 'zod'
import { compareStageOutputs } from './stage-comparison'
import { createNightSummary } from './night-summary-core'
import { createNightUncertainty } from './uncertainty-core'
import { intersectOutputSupport } from './common-support'
import { classifySleepStages, type SleepStageBlock } from '@/src/lib/sleep-stages'
import { biometricManifest, validateConfig } from '../algorithms/registry-core'
import { alignReferences, DEFAULT_ALIGNMENT } from '../references/alignment'
import { scoreStageDurations } from '../references/stage-scoring'
import { datasetSnapshotSchema, enqueueBacktestSchema, experimentProtocolSchema } from './contracts'

export const backtestWorkSchema = z.object({
  job: enqueueBacktestSchema.extend({ version: z.literal('backtest-job-v1'), datasetId: z.string().uuid(),
    datasetHash: z.string(), protocol: experimentProtocolSchema, protocolHash: z.string(), holdoutUse: z.number().int().nonnegative(),
    evidence: z.enum(['descriptive_only', 'reused_holdout_is_validation']),
  }),
  dataset: z.object({ manifest: z.unknown(), snapshot: datasetSnapshotSchema }),
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
    const { job, dataset } = backtestWorkSchema.parse(raw)
    if (dataHash(dataset) !== job.datasetHash || configHash(job.protocol) !== job.protocolHash) throw new Error('Evaluation input integrity mismatch')
    const assignments = assignmentsSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === job.split)
    if (!assignments.length) throw new Error('No nights in selected split')
    const configs = job.configs.map((config) => {
      const resolved = validateConfig(config.resolved)
      if (config.manifestHash !== manifestHash || configHash(resolved) !== config.resolvedHash) throw new Error('Evaluation engine/configuration mismatch')
      return { ...config, resolved }
    })
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
        const rows = vitals.filter(row => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)
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
        if (job.protocol.mode === 'stage_replay') {
          const epochs = classifySleepStages(rows.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })),
            moves.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })), job.protocol.assumedStageCalibrationQuality, config.resolved.sleep_stages.ruleset)
          blocks = epochs.map(epoch => ({ start: epoch.start, end: Math.min(window.endMs, epoch.start + epoch.duration), stage: epoch.stage })).filter(row => row.end > row.start)
        }
        return { ...window, observationCount: rows.length, numeric,
          stage: job.protocol.mode === 'stage_replay'
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
      const sharedSupport = job.protocol.mode === 'stage_replay'
        ? windows.map((window, index) =>
            intersectOutputSupport(evaluations.map(evaluation => shift(evaluation.windows[index].blocks)), window.startMs, window.endMs))
        : []
      const comparisons = job.protocol.mode === 'stage_replay'
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
      return { cohortId: assignment.cohortId, sessionIds: assignment.sessionIds, uniqueObservationCount: vitals.length, evaluations, comparisons }
    })
    return { version: 'processed-backtest-report-v1' as const, datasetId: job.datasetId, datasetHash: job.datasetHash,
      evaluatorBuildHash: job.evaluatorBuildHash, protocol: job.protocol, protocolHash: job.protocolHash, manifestHash, support: 'identical_retained_epoch_intervals' as const, split: job.split, holdoutUse: job.holdoutUse,
      status: 'insufficient_evidence' as const, evidence: job.evidence, nights, stageNightSummary: summarizeStageNights(nights, job.protocol.nightUncertainty),
      calibration: { source: 'explicit_assumption' as const, quality: job.protocol.assumedStageCalibrationQuality },
      limitations: ['This descriptive report does not establish validated improvement.',
        'Numeric readings are original observations; parameter changes to waveform processing are not evaluated by processed-data replay.',
        'Stages use the shared retrospective classifier, including its bounded gap-duration semantics; they are not causal predictions.',
        'Calibration quality is an explicit assumption, not recovered historical sensor calibration.',
        'Overlapping sessions share one input set; disconnected sessions are classified separately.',
        'Holdout exposure must be rechecked before any later promotion decision.'],
    }
  }
}
