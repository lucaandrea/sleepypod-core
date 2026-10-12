import type { NormalizedMeasurement, ReferenceMetric } from './contracts'
import { ReferenceInputError } from './time'

export interface Observation {
  timestampMs: number
  value: number | null
  /** Known support duration only; a point reading must not imply gap filling. */
  durationMs?: number
}
export interface AlignmentPolicy {
  version: 'reference-alignment-v1'
  pointToleranceMs: number
  clockOffsetMs: number
  offsetSource: 'fixed' | 'training'
}
export const DEFAULT_ALIGNMENT: AlignmentPolicy = { version: 'reference-alignment-v1', pointToleranceMs: 30000, clockOffsetMs: 0, offsetSource: 'fixed' }

export function referenceCompatibility(metric: ReferenceMetric, windowMs: number | null, reference: NormalizedMeasurement): string | null {
  if (!reference.scorable) return reference.exclusions.join(',') || 'unscorable_reference'
  if (metric === 'hrv_unknown' || reference.metric === 'hrv_unknown') return 'unknown_hrv_definition'
  if (reference.metric !== metric) return 'incompatible_metric_definition'
  if (metric.startsWith('hrv_') || metric === 'window_ibi_variability_v1') {
    if (windowMs === null || reference.windowMs === null || reference.windowMs !== windowMs) return 'incompatible_hrv_window'
  }
  return null
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
}

function unionDuration(intervals: Array<[number, number]>): number {
  let total = 0, end = -Infinity
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end))
    end = Math.max(end, stop)
  }
  return total
}

/**
 * Greedy chronological, nearest-unused point pairing; interval mean/median
 * uses only actual pod samples inside the interval. No forward fill. Each
 * observation and reference can contribute to at most one independent pair.
 * Offset is supplied by a frozen protocol; never fitted on the evaluation set.
 */
export function alignReferences(metric: ReferenceMetric, windowMs: number | null, observations: Observation[], references: NormalizedMeasurement[], policy: AlignmentPolicy = DEFAULT_ALIGNMENT) {
  if (metric === 'sleep_stages') throw new ReferenceInputError('INCOMPATIBLE_METRIC', 'Use the duration-weighted stage evaluator')
  if (policy.version !== 'reference-alignment-v1' || !['fixed', 'training'].includes(policy.offsetSource)
    || !Number.isFinite(policy.pointToleranceMs) || policy.pointToleranceMs < 0 || policy.pointToleranceMs > 300000
    || !Number.isFinite(policy.clockOffsetMs) || Math.abs(policy.clockOffsetMs) > 3600000) throw new ReferenceInputError('INVALID_ALIGNMENT', 'Unsupported alignment policy')
  if (observations.length > 100000 || references.length > 100000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Use bounded whole-night datasets')
  for (const observation of observations) {
    if (!Number.isFinite(observation.timestampMs) || (observation.value !== null && (!Number.isFinite(observation.value) || Math.abs(observation.value) > Number.MAX_SAFE_INTEGER))
      || (observation.durationMs !== undefined && (!Number.isFinite(observation.durationMs) || observation.durationMs < 0 || observation.durationMs > 300000))) {
      throw new ReferenceInputError('INVALID_OBSERVATION', 'Observation timestamps, values and support durations must be finite and bounded')
    }
  }
  const available = observations.filter(row => row.value !== null).map(row => ({ ...row, timestampMs: row.timestampMs + policy.clockOffsetMs })).sort((a, b) => a.timestampMs - b.timestampMs)
  const used = new Set<number>()
  const duplicateKeys = new Set<string>()
  const exclusions: Record<string, number> = {}
  let eligibleReferences = 0, duplicateReferences = 0
  const pairs: Array<{ referenceKey: string, referenceStartMs: number, referenceEndMs: number, referenceValue: number, podValue: number, podCount: number, signedError: number, pairedDurationMs: number }> = []
  let comparisons = 0
  for (const reference of [...references].sort((a, b) => a.startMs - b.startMs || a.recordKey.localeCompare(b.recordKey))) {
    const incompatible = referenceCompatibility(metric, windowMs, reference)
    if (incompatible) {
      exclusions[incompatible] = (exclusions[incompatible] ?? 0) + 1
      continue
    }
    if (reference.value === null || !Number.isFinite(reference.value) || Math.abs(reference.value) > Number.MAX_SAFE_INTEGER) throw new ReferenceInputError('INVALID_REFERENCE', 'Numeric reference value is required')
    const key = JSON.stringify([reference.metric, reference.startMs, reference.endMs, reference.value, reference.aggregation, reference.windowMs])
    if (duplicateKeys.has(key)) {
      duplicateReferences++
      continue
    }
    duplicateKeys.add(key)
    eligibleReferences++
    const isPoint = reference.temporalKind === 'point'
    const start = reference.startMs - (isPoint ? policy.pointToleranceMs : 0)
    const end = reference.endMs + (isPoint ? policy.pointToleranceMs : 0)
    let lower = 0, upper = available.length
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (available[middle].timestampMs < start) lower = middle + 1
      else upper = middle
    }
    const candidates: number[] = []
    for (let i = lower; i < available.length; i++) {
      if (++comparisons > 2000000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Overlapping reference windows exceed the alignment work budget')
      const timestamp = available[i].timestampMs
      if (isPoint ? timestamp > end : timestamp >= end) break
      if (!used.has(i)) candidates.push(i)
    }
    if (!candidates.length) continue
    let selected = candidates
    if (isPoint) {
      selected = [candidates.reduce((best, index) => Math.abs(available[index].timestampMs - reference.startMs) < Math.abs(available[best].timestampMs - reference.startMs) ? index : best)]
    }
    const values = selected.map(index => available[index].value as number)
    const podValue = reference.aggregation === 'median' ? quantile(values, 0.5) : values.reduce((sum, value) => sum + value, 0) / values.length
    const support: Array<[number, number]> = []
    for (const index of selected) {
      used.add(index)
      const observation = available[index]
      if (!isPoint && observation.durationMs) support.push([observation.timestampMs, Math.min(reference.endMs, observation.timestampMs + observation.durationMs)])
    }
    pairs.push({ referenceKey: reference.recordKey, referenceStartMs: reference.startMs, referenceEndMs: reference.endMs,
      referenceValue: reference.value, podValue, podCount: selected.length, signedError: podValue - reference.value, pairedDurationMs: unionDuration(support) })
  }
  const errors = pairs.map(pair => Math.abs(pair.signedError))
  return {
    status: !references.length ? 'no_reference' as const : pairs.length ? 'compared' as const : eligibleReferences ? 'no_overlap' as const : 'incompatible' as const,
    metric, windowMs, policy: { ...policy },
    metrics: pairs.length
      ? { mae: errors.reduce((sum, error) => sum + error, 0) / errors.length,
          medianAbsoluteError: quantile(errors, 0.5), p95AbsoluteError: quantile(errors, 0.95),
          signedBias: pairs.reduce((sum, pair) => sum + pair.signedError, 0) / pairs.length }
      : null,
    pairedCount: pairs.length, pairedDurationMs: pairs.reduce((sum, pair) => sum + pair.pairedDurationMs, 0),
    eligibleReferences, duplicateReferences, excludedReferences: references.length - eligibleReferences - duplicateReferences,
    referenceCoverage: eligibleReferences ? pairs.length / eligibleReferences : null,
    outputCoverage: observations.length ? available.length / observations.length : null,
    observationCount: observations.length, validObservationCount: available.length, matchedObservationCount: used.size,
    unmatchedReferences: eligibleReferences - pairs.length, unmatchedObservations: available.length - used.size,
    exclusions, pairs,
    limitations: ['Sparse reference samples do not establish whole-night accuracy.', 'Point samples contribute counts, not inferred duration.', 'Interval comparisons use available observations without filling gaps.'],
  }
}
