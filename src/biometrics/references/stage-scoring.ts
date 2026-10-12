import type { SleepStage, SleepStageBlock } from '@/src/lib/sleep-stages'
import type { NormalizedMeasurement } from './contracts'
import { ReferenceInputError } from './time'

const STAGES: SleepStage[] = ['wake', 'light', 'deep', 'rem']
const emptyStages = () => ({ wake: 0, light: 0, deep: 0, rem: 0 })

/** Duration scoring on actual intersecting support, never midpoint labels or gap fill. */
export function scoreStageDurations(predictions: SleepStageBlock[], references: NormalizedMeasurement[], startMs: number, endMs: number) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs || endMs - startMs > 86400000
    || predictions.length > 100000 || references.length > 100000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Use bounded stage intervals within one day')
  const predicted = predictions.map(row => ({ ...row })).sort((a, b) => a.start - b.start)
  for (let i = 0; i < predicted.length; i++) {
    const row = predicted[i]
    if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.end <= row.start || !STAGES.includes(row.stage)
      || (i > 0 && predicted[i - 1].end > row.start)) throw new ReferenceInputError('INVALID_OBSERVATION', 'Predicted stage intervals must be valid and nonoverlapping')
  }
  const exclusions: Record<string, number> = {}
  const eligible: SleepStageBlock[] = []
  for (const row of references) {
    if (row.endMs <= startMs || row.startMs >= endMs) continue
    const reason = row.metric !== 'sleep_stages'
      ? 'incompatible_metric_definition'
      : !row.scorable
          ? row.exclusions.join(',') || 'unscorable_reference'
          : row.stage === null || !STAGES.includes(row.stage as SleepStage) ? 'unknown_stage' : null
    if (reason) {
      exclusions[reason] = (exclusions[reason] ?? 0) + 1
      continue
    }
    if (!Number.isSafeInteger(row.startMs) || !Number.isSafeInteger(row.endMs) || row.endMs <= row.startMs) throw new ReferenceInputError('INVALID_REFERENCE', 'Stage references require valid intervals')
    eligible.push({ start: Math.max(startMs, row.startMs), end: Math.min(endMs, row.endMs), stage: row.stage as SleepStage })
  }
  // Sweep all boundaries: duplicate equal labels collapse; conflicting labels
  // leave that exact interval unscored, including conflicts across imports.
  const events = new Map<number, Array<{ stage: SleepStage, delta: number }>>()
  for (const row of eligible) {
    if (!events.has(row.start)) events.set(row.start, [])
    if (!events.has(row.end)) events.set(row.end, [])
    events.get(row.start)?.push({ stage: row.stage, delta: 1 })
    events.get(row.end)?.push({ stage: row.stage, delta: -1 })
  }
  const boundaries = [...events.keys()].sort((a, b) => a - b)
  const active = emptyStages()
  const normalized: SleepStageBlock[] = []
  let conflictingReferenceMs = 0
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1]
    for (const event of events.get(start) ?? []) active[event.stage] += event.delta
    const labels = STAGES.filter(stage => active[stage] > 0)
    if (labels.length > 1) conflictingReferenceMs += end - start
    else if (labels.length === 1) normalized.push({ start, end, stage: labels[0] })
  }
  const confusionMs = { wake: emptyStages(), light: emptyStages(), deep: emptyStages(), rem: emptyStages() }
  const predictedDurationMs = emptyStages(), referenceDurationMs = emptyStages()
  let pairedDurationMs = 0, p = 0, r = 0
  const common: Array<{ start: number, end: number, predicted: SleepStage, reference: SleepStage }> = []
  while (p < predicted.length && r < normalized.length) {
    const pod = predicted[p], ref = normalized[r]
    const start = Math.max(startMs, pod.start, ref.start), end = Math.min(endMs, pod.end, ref.end)
    if (end > start) {
      const duration = end - start
      confusionMs[ref.stage][pod.stage] += duration
      predictedDurationMs[pod.stage] += duration
      referenceDurationMs[ref.stage] += duration
      pairedDurationMs += duration
      common.push({ start, end, predicted: pod.stage, reference: ref.stage })
    }
    if (pod.end <= ref.end) p++
    else r++
  }
  const perStage = STAGES.map((stage) => {
    const truePositive = confusionMs[stage][stage]
    const precision = predictedDurationMs[stage] ? truePositive / predictedDurationMs[stage] : null
    const recall = referenceDurationMs[stage] ? truePositive / referenceDurationMs[stage] : null
    const denominator = predictedDurationMs[stage] + referenceDurationMs[stage]
    return { stage, precision, recall, f1: denominator ? 2 * truePositive / denominator : null,
      supportMs: referenceDurationMs[stage], predictedMs: predictedDurationMs[stage], durationDifferenceMs: predictedDurationMs[stage] - referenceDurationMs[stage] }
  })
  const definedF1 = perStage.flatMap(row => row.f1 === null ? [] : [row.f1])
  let predictedTransitions = 0, referenceTransitions = 0
  for (let i = 1; i < common.length; i++) {
    if (common[i - 1].end !== common[i].start) continue // never infer a transition across a gap
    if (common[i - 1].predicted !== common[i].predicted) predictedTransitions++
    if (common[i - 1].reference !== common[i].reference) referenceTransitions++
  }
  const eligibleReferenceMs = normalized.reduce((total, row) => total + row.end - row.start, 0)
  const outputDurationMs = predicted.reduce((total, row) => total + Math.max(0, Math.min(endMs, row.end) - Math.max(startMs, row.start)), 0)
  return { version: 'duration-stage-agreement-v1' as const,
    status: pairedDurationMs ? 'compared' as const : eligibleReferenceMs ? 'no_overlap' as const : 'no_scorable_reference' as const,
    confusionMs, perStage, macroF1: definedF1.length ? definedF1.reduce((sum, value) => sum + value, 0) / definedF1.length : null,
    agreement: pairedDurationMs ? STAGES.reduce((sum, stage) => sum + confusionMs[stage][stage], 0) / pairedDurationMs : null,
    pairedDurationMs, eligibleReferenceMs, conflictingReferenceMs, outputDurationMs,
    unscoredDurationMs: endMs - startMs - pairedDurationMs,
    referenceCoverage: eligibleReferenceMs ? pairedDurationMs / eligibleReferenceMs : null,
    outputCoverage: outputDurationMs / (endMs - startMs),
    predictedTransitions, referenceTransitions, transitionDifference: predictedTransitions - referenceTransitions,
    exclusions, limitations: ['Agreement is with the named reference, not clinical stage accuracy.',
      'Stage duration and transition differences use common scored support only.',
      'Macro F1 excludes classes absent from both outputs and references; inspect class support.'],
  }
}
