import type { SleepStageBlock } from '@/src/lib/sleep-stages'
import type { NormalizedMeasurement } from '../references/contracts'
import { scoreStageDurations } from '../references/stage-scoring'

const summarize = (score: ReturnType<typeof scoreStageDurations>) => ({
  agreement: score.agreement, macroF1: score.macroF1, pairedDurationMs: score.pairedDurationMs,
  eligibleReferenceMs: score.eligibleReferenceMs, outputDurationMs: score.outputDurationMs,
  referenceCoverage: score.referenceCoverage, outputCoverage: score.outputCoverage,
})
const difference = (candidate: number | null, baseline: number | null) => candidate === null || baseline === null ? null : candidate - baseline

/** Compare accuracy on exactly the same intervals, while preserving each
 * output's own support. Dropping hard intervals cannot manufacture an accuracy
 * gain on common support. This is descriptive evidence, not a promotion gate. */
export function compareStageOutputs(baseline: SleepStageBlock[], candidate: SleepStageBlock[], references: NormalizedMeasurement[], startMs: number, endMs: number) {
  // The shared scorer validates ordering/overlap and normalizes conflicts across
  // reference imports identically for both outputs.
  const baselineOwn = scoreStageDurations(baseline, references, startMs, endMs)
  const candidateOwn = scoreStageDurations(candidate, references, startMs, endMs)
  const left = [...baseline].sort((a, b) => a.start - b.start)
  const right = [...candidate].sort((a, b) => a.start - b.start)
  const commonBaseline: SleepStageBlock[] = [], commonCandidate: SleepStageBlock[] = []
  let i = 0, j = 0
  while (i < left.length && j < right.length) {
    const a = left[i], b = right[j]
    const start = Math.max(startMs, a.start, b.start), end = Math.min(endMs, a.end, b.end)
    if (end > start) {
      commonBaseline.push({ start, end, stage: a.stage })
      commonCandidate.push({ start, end, stage: b.stage })
    }
    if (a.end <= b.end) i++
    else j++
  }
  const baselineCommon = scoreStageDurations(commonBaseline, references, startMs, endMs)
  const candidateCommon = scoreStageDurations(commonCandidate, references, startMs, endMs)
  return { version: 'paired-stage-support-v1' as const,
    ownSupport: { baseline: summarize(baselineOwn), candidate: summarize(candidateOwn) },
    commonSupport: { baseline: summarize(baselineCommon), candidate: summarize(candidateCommon),
      baselineConfusionMs: baselineCommon.confusionMs, candidateConfusionMs: candidateCommon.confusionMs },
    differences: {
      commonAgreement: difference(candidateCommon.agreement, baselineCommon.agreement),
      commonMacroF1: difference(candidateCommon.macroF1, baselineCommon.macroF1),
      ownAgreement: difference(candidateOwn.agreement, baselineOwn.agreement),
      referenceCoverage: difference(candidateOwn.referenceCoverage, baselineOwn.referenceCoverage),
      outputCoverage: candidateOwn.outputCoverage - baselineOwn.outputCoverage,
      pairedDurationMs: candidateOwn.pairedDurationMs - baselineOwn.pairedDurationMs,
    },
    coverageReduced: candidateOwn.pairedDurationMs < baselineOwn.pairedDurationMs || candidateOwn.outputDurationMs < baselineOwn.outputDurationMs,
    interpretation: 'descriptive_agreement_not_validated_improvement' as const,
  }
}
