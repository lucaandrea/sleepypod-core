import type { compareNumericConfigurations } from './numeric-comparison'
import type { createNightUncertainty } from './uncertainty-core'
import type { NightBootstrapPolicy } from './uncertainty-policy'

type Comparison = ReturnType<typeof compareNumericConfigurations>[number]
interface Window { startMs: number, endMs: number, metrics: Comparison[] }
interface Night { cohortId: string, numericComparisons?: Window[] }
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
function pooled(rows: Comparison[], side: 'baseline' | 'candidate') {
  let pairedCount = 0, absoluteError = 0, signedError = 0
  for (const row of rows) {
    const score = row.commonSupport[side]
    if (score.metrics && score.pairedCount) {
      pairedCount += score.pairedCount
      absoluteError += score.metrics.mae * score.pairedCount
      signedError += score.metrics.signedBias * score.pairedCount
    }
  }
  // Quantiles cannot be pooled from window quantiles; deliberately omit them.
  return { pairedCount, mae: pairedCount ? absoluteError / pairedCount : null, signedBias: pairedCount ? signedError / pairedCount : null }
}

/** Weight references within each whole night, then weight nights equally. */
export function createNumericNightSummary(uncertainty: ReturnType<typeof createNightUncertainty>) {
  return function summarize(nights: Night[], policy?: NightBootstrapPolicy) {
    if (nights.length > 60 || new Set(nights.map(night => night.cohortId)).size !== nights.length) throw new Error('Invalid numeric night cohorts')
    const groups = new Map<string, {
      identity: Pick<Comparison, 'metric' | 'baseline' | 'candidate' | 'baselineHash' | 'candidateHash'>
      nights: Array<{
        cohortId: string
        commonSupport: { baseline: ReturnType<typeof pooled>, candidate: ReturnType<typeof pooled> }
        commonMaeDifference: number | null
        coverageReduced: boolean
        lostObservationTimestamps: number
        addedObservationTimestamps: number
      }>
      rows: Comparison[]
    }>()
    for (const night of nights) {
      const windows = [...(night.numericComparisons ?? [])].sort((a, b) => a.startMs - b.startMs)
      if (windows.length > 60 || windows.some((window, i) => !Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs)
        || window.endMs <= window.startMs || window.endMs - window.startMs > 86400000 || (i > 0 && windows[i - 1].endMs > window.startMs))) throw new Error('Invalid numeric night windows')
      const local = new Map<string, Comparison[]>()
      for (const window of windows) {
        if (window.metrics.length > 9) throw new Error('Too many numeric comparisons')
        const seen = new Set<string>()
        for (const row of window.metrics) {
          const identity = { metric: row.metric, baseline: row.baseline, candidate: row.candidate, baselineHash: row.baselineHash, candidateHash: row.candidateHash }
          const key = JSON.stringify(identity)
          if (seen.has(key)) throw new Error('Duplicate numeric comparison')
          if (row.commonSupport.baseline.pairedCount !== row.commonSupport.candidate.pairedCount) throw new Error('Unequal common reference support')
          seen.add(key)
          const rows = local.get(key) ?? []
          rows.push(row)
          local.set(key, rows)
          if (!groups.has(key)) groups.set(key, { identity, nights: [], rows: [] })
        }
      }
      for (const [key, rows] of local) {
        const group = groups.get(key)
        if (!group) throw new Error('Missing numeric comparison group')
        const baseline = pooled(rows, 'baseline'), candidate = pooled(rows, 'candidate')
        group.rows.push(...rows)
        group.nights.push({ cohortId: night.cohortId, commonSupport: { baseline, candidate },
          commonMaeDifference: baseline.mae === null || candidate.mae === null ? null : candidate.mae - baseline.mae,
          coverageReduced: rows.some(row => row.coverageReduced),
          lostObservationTimestamps: rows.reduce((sum, row) => sum + row.lostObservationTimestamps, 0),
          addedObservationTimestamps: rows.reduce((sum, row) => sum + row.addedObservationTimestamps, 0) })
      }
    }
    return [...groups.values()].map((group) => {
      const values = group.nights.flatMap(night => night.commonMaeDifference === null ? [] : [night.commonMaeDifference])
      return { ...group.identity, version: 'numeric-night-summary-v1' as const, nights: group.nights,
        totalNights: group.nights.length, scoredNights: values.length, unscoredNights: group.nights.length - values.length,
        improvedErrorNights: values.filter(value => value < 0).length, regressedErrorNights: values.filter(value => value > 0).length,
        unchangedErrorNights: values.filter(value => value === 0).length, coverageReducedNights: group.nights.filter(night => night.coverageReduced).length,
        equalNightMeanMaeDifference: mean(values),
        pooledCommonSupport: { baseline: pooled(group.rows, 'baseline'), candidate: pooled(group.rows, 'candidate') },
        uncertainty: uncertainty(group.nights.map(night => ({ cohortId: night.cohortId, difference: night.commonMaeDifference })), policy),
        interpretation: 'descriptive_numeric_agreement_not_validated_improvement' as const }
    })
  }
}
