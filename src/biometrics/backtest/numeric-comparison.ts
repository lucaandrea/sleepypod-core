import { alignReferences, type AlignmentPolicy, type Observation } from '../references/alignment'
import type { NormalizedMeasurement, ReferenceMetric } from '../references/contracts'

type Label = 'default' | 'current' | 'candidate'
interface Output { label: Label, configHash: string, observations: Observation[] }
const summary = (score: ReturnType<typeof alignReferences>) => ({ status: score.status, metrics: score.metrics,
  pairedCount: score.pairedCount, referenceCoverage: score.referenceCoverage, validObservationCount: score.validObservationCount,
  unmatchedReferences: score.unmatchedReferences, unmatchedObservations: score.unmatchedObservations })
const difference = (candidate: number | null, baseline: number | null) => candidate === null || baseline === null ? null : candidate - baseline

/** Equal timestamps, not nearest output-to-output matching. All configurations
 * contribute to the intersection before reference alignment, so dropping a hard
 * sample cannot change an interval's aggregation support in only one result.
 * Duplicate timestamps are ambiguous and excluded from common support. Known
 * durations are deliberately not inferred from point timestamps.
 */
export function compareNumericConfigurations(metric: ReferenceMetric, windowMs: number | null, outputs: Output[], references: NormalizedMeasurement[], policy: AlignmentPolicy) {
  if (outputs.length < 2 || outputs.length > 3 || new Set(outputs.map(output => output.label)).size !== outputs.length) throw new Error('Invalid numeric comparison configurations')
  const own = outputs.map(output => alignReferences(metric, windowMs, output.observations, references, policy))
  const indexes = outputs.map((output) => {
    const values = new Map<number, number>(), seen = new Set<number>(), ambiguous = new Set<number>()
    for (const row of output.observations) {
      if (seen.has(row.timestampMs)) {
        ambiguous.add(row.timestampMs)
        values.delete(row.timestampMs)
      }
      seen.add(row.timestampMs)
      if (!ambiguous.has(row.timestampMs) && row.value !== null) values.set(row.timestampMs, row.value)
    }
    return { values, ambiguous }
  })
  const timestamps = [...indexes[0].values.keys()].filter(timestamp => indexes.every(index => index.values.has(timestamp))).sort((a, b) => a - b)
  const common = indexes.map(index => alignReferences(metric, windowMs,
    timestamps.map(timestampMs => ({ timestampMs, value: index.values.get(timestampMs) ?? null })), references, policy))
  return outputs.flatMap((candidate, c) => outputs.flatMap((baseline, b) => {
    if (!((candidate.label === 'candidate' && baseline.label !== 'candidate') || (candidate.label === 'current' && baseline.label === 'default'))) return []
    const lost = [...indexes[b].values.keys()].filter(timestamp => !indexes[c].values.has(timestamp)).length
    const added = [...indexes[c].values.keys()].filter(timestamp => !indexes[b].values.has(timestamp)).length
    return [{ version: 'paired-numeric-support-v1' as const, metric,
      baseline: baseline.label, candidate: candidate.label, baselineHash: baseline.configHash, candidateHash: candidate.configHash,
      commonSupportScope: 'all_configurations' as const, supportDefinition: 'identical_unambiguous_observation_timestamps' as const,
      commonObservationCount: timestamps.length,
      ownSupport: { baseline: summary(own[b]), candidate: summary(own[c]) },
      commonSupport: { baseline: summary(common[b]), candidate: summary(common[c]) },
      differences: {
        commonMae: difference(common[c].metrics?.mae ?? null, common[b].metrics?.mae ?? null),
        commonMedianAbsoluteError: difference(common[c].metrics?.medianAbsoluteError ?? null, common[b].metrics?.medianAbsoluteError ?? null),
        commonP95AbsoluteError: difference(common[c].metrics?.p95AbsoluteError ?? null, common[b].metrics?.p95AbsoluteError ?? null),
        commonSignedBias: difference(common[c].metrics?.signedBias ?? null, common[b].metrics?.signedBias ?? null),
        ownMae: difference(own[c].metrics?.mae ?? null, own[b].metrics?.mae ?? null),
        referenceCoverage: difference(own[c].referenceCoverage, own[b].referenceCoverage),
      },
      lostObservationTimestamps: lost, addedObservationTimestamps: added,
      ambiguousObservationTimestamps: { baseline: indexes[b].ambiguous.size, candidate: indexes[c].ambiguous.size },
      coverageReduced: lost > 0 || own[c].pairedCount < own[b].pairedCount,
      interpretation: 'descriptive_numeric_agreement_not_validated_improvement' as const,
    }]
  }))
}
