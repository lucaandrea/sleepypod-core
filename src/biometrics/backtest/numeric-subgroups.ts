import type { NormalizedMeasurement } from '../references/contracts'

/** Fixed reference-defined groups; never select membership using candidate
 * output, error, quality, or coverage. Interval records are never split. */
export const numericSubgroupNames = ['reference_points', 'reference_intervals', 'window_first_half', 'window_second_half'] as const
export type NumericSubgroupName = typeof numericSubgroupNames[number]
export function subgroupReferences(name: NumericSubgroupName, rows: NormalizedMeasurement[], window: { startMs: number, endMs: number }) {
  const middle = window.startMs + (window.endMs - window.startMs) / 2
  return rows.filter(row => name === 'reference_points'
    ? row.temporalKind === 'point'
    : name === 'reference_intervals'
      ? row.temporalKind === 'interval'
      : name === 'window_first_half'
        ? (row.temporalKind === 'point' ? row.startMs < middle : row.endMs <= middle)
        : row.startMs >= middle)
}

export function subgroupBoundaryExclusions(name: NumericSubgroupName, rows: NormalizedMeasurement[], window: { startMs: number, endMs: number }) {
  if (name !== 'window_first_half' && name !== 'window_second_half') return 0
  const middle = window.startMs + (window.endMs - window.startMs) / 2
  return rows.filter(row => row.temporalKind === 'interval' && row.startMs < middle && row.endMs > middle).length
}

interface Identity {
  baseline: string
  candidate: string
  metric: string
  baselineHash: string
  candidateHash: string
}
interface SubgroupSummary extends Identity {
  name: string
  nights: Array<{ commonMaeDifference: number | null, commonSupport: { candidate: { pairedCount: number } } }>
}
export function subgroupObjectiveEvidence(summaries: SubgroupSummary[], identity: Identity, minimumPairs: number) {
  return summaries.filter(row => row.baseline === identity.baseline && row.candidate === identity.candidate && row.metric === identity.metric
    && row.baselineHash === identity.baselineHash && row.candidateHash === identity.candidateHash).map((row) => {
    const supported = row.nights.filter(night => night.commonMaeDifference !== null && night.commonSupport.candidate.pairedCount >= minimumPairs)
    return { name: row.name, pairedNights: supported.length,
      maeDifference: supported.length > 0 && supported.length === row.nights.length
        ? supported.reduce((sum, night) => sum + (night.commonMaeDifference ?? 0), 0) / supported.length
        : null }
  })
}
