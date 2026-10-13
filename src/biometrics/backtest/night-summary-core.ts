import type { NightBootstrapPolicy } from './uncertainty-policy'
import type { createNightUncertainty } from './uncertainty-core'
import type { compareStageOutputs } from './stage-comparison'

type WindowComparison = ReturnType<typeof compareStageOutputs> & { startMs: number, endMs: number }
interface NightComparison {
  baseline: string
  candidate: string
  baselineHash: string
  candidateHash: string
  windows: WindowComparison[]
}
interface Night { cohortId: string, comparisons: NightComparison[] }
const stages = ['wake', 'light', 'deep', 'rem'] as const
const difference = (a: number | null, b: number | null) => a === null || b === null ? null : a - b
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

function commonScore(windows: WindowComparison[], side: 'baseline' | 'candidate') {
  const confusionMs = { wake: { wake: 0, light: 0, deep: 0, rem: 0 }, light: { wake: 0, light: 0, deep: 0, rem: 0 },
    deep: { wake: 0, light: 0, deep: 0, rem: 0 }, rem: { wake: 0, light: 0, deep: 0, rem: 0 } }
  for (const window of windows) {
    const matrix = side === 'baseline' ? window.commonSupport.baselineConfusionMs : window.commonSupport.candidateConfusionMs
    for (const reference of stages) for (const predicted of stages) confusionMs[reference][predicted] += matrix[reference][predicted]
  }
  const perStage = stages.map((stage) => {
    const referenceMs = stages.reduce((sum, predicted) => sum + confusionMs[stage][predicted], 0)
    const predictedMs = stages.reduce((sum, reference) => sum + confusionMs[reference][stage], 0)
    const correctMs = confusionMs[stage][stage]
    return { stage, referenceMs, predictedMs, precision: predictedMs ? correctMs / predictedMs : null,
      recall: referenceMs ? correctMs / referenceMs : null, f1: referenceMs + predictedMs ? 2 * correctMs / (referenceMs + predictedMs) : null }
  })
  const pairedDurationMs = perStage.reduce((sum, row) => sum + row.referenceMs, 0)
  const correctMs = stages.reduce((sum, stage) => sum + confusionMs[stage][stage], 0)
  return { confusionMs, perStage, pairedDurationMs, agreement: pairedDurationMs ? correctMs / pairedDurationMs : null,
    macroF1: mean(perStage.flatMap(row => row.f1 === null ? [] : [row.f1])) }
}

function summarizeNight(cohortId: string, comparison: NightComparison) {
  const baseline = commonScore(comparison.windows, 'baseline'), candidate = commonScore(comparison.windows, 'candidate')
  const durationMs = comparison.windows.reduce((sum, window) => sum + window.endMs - window.startMs, 0)
  const ownSupport = (side: 'baseline' | 'candidate') => {
    const totals = comparison.windows.reduce((sum, window) => {
      const score = window.ownSupport[side]
      return { outputMs: sum.outputMs + score.outputDurationMs, pairedMs: sum.pairedMs + score.pairedDurationMs,
        referenceMs: sum.referenceMs + score.eligibleReferenceMs, correctMs: sum.correctMs + (score.agreement ?? 0) * score.pairedDurationMs }
    }, { outputMs: 0, pairedMs: 0, referenceMs: 0, correctMs: 0 })
    return { ...totals, agreement: totals.pairedMs ? totals.correctMs / totals.pairedMs : null,
      outputCoverage: durationMs ? totals.outputMs / durationMs : null,
      referenceCoverage: totals.referenceMs ? totals.pairedMs / totals.referenceMs : null }
  }
  return { cohortId, evaluationDurationMs: durationMs, commonOutputDurationMs: comparison.windows.reduce((sum, window) => sum + window.commonSupport.baseline.outputDurationMs, 0), commonSupport: { baseline, candidate },
    ownSupport: { baseline: ownSupport('baseline'), candidate: ownSupport('candidate') },
    commonAgreementDifference: difference(candidate.agreement, baseline.agreement),
    commonMacroF1Difference: difference(candidate.macroF1, baseline.macroF1),
    coverageReduced: comparison.windows.some(window => window.coverageReduced) }
}

/** Aggregate disconnected windows within each whole-night cohort first. Equal
 * night means and pooled duration scores are both explicit; neither silently
 * substitutes epochs for independent nights. No promotion status is inferred. */
export function createNightSummary(nightUncertainty: ReturnType<typeof createNightUncertainty>) {
  return function summarizeStageNights(nights: Night[], uncertaintyPolicy?: NightBootstrapPolicy) {
    if (nights.length > 60 || new Set(nights.map(night => night.cohortId)).size !== nights.length) throw new Error('Invalid whole-night summary input')
    const groups = new Map<string, { identity: Omit<NightComparison, 'windows'>, nights: ReturnType<typeof summarizeNight>[], windows: WindowComparison[] }>()
    for (const night of nights) {
      if (night.comparisons.length > 3) throw new Error('Too many comparisons within night')
      const seen = new Set<string>()
      for (const comparison of night.comparisons) {
        const { windows, ...identity } = comparison
        const ordered = [...windows].sort((a, b) => a.startMs - b.startMs)
        if (ordered.length > 60 || ordered.some((window, index) => !Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs)
          || window.endMs <= window.startMs || window.endMs - window.startMs > 86400000 || (index > 0 && ordered[index - 1].endMs > window.startMs))) {
          throw new Error('Nightly comparison windows must be bounded and nonoverlapping')
        }
        const key = JSON.stringify(identity)
        if (seen.has(key)) throw new Error('Duplicate comparison within night')
        seen.add(key)
        const group = groups.get(key) ?? { identity, nights: [], windows: [] }
        group.nights.push(summarizeNight(night.cohortId, comparison))
        group.windows.push(...windows)
        groups.set(key, group)
      }
    }
    return [...groups.values()].map((group) => {
      const deltas = group.nights.flatMap(night => night.commonAgreementDifference === null ? [] : [night.commonAgreementDifference])
      return { ...group.identity, nights: group.nights,
        totalNights: group.nights.length, scoredNights: deltas.length, unscoredNights: group.nights.length - deltas.length,
        improvedAgreementNights: deltas.filter(delta => delta > 0).length,
        regressedAgreementNights: deltas.filter(delta => delta < 0).length,
        unchangedAgreementNights: deltas.filter(delta => delta === 0).length,
        coverageReducedNights: group.nights.filter(night => night.coverageReduced).length,
        equalNightMeanAgreementDifference: mean(deltas),
        uncertainty: nightUncertainty(group.nights.map(night => ({ cohortId: night.cohortId, difference: night.commonAgreementDifference })), uncertaintyPolicy),
        observedNightRange: deltas.length ? { minimum: Math.min(...deltas), maximum: Math.max(...deltas) } : null,
        pooledCommonSupport: { baseline: commonScore(group.windows, 'baseline'), candidate: commonScore(group.windows, 'candidate') },
        interpretation: 'descriptive_night_aggregation_not_confidence_interval' as const }
    })
  }
}
