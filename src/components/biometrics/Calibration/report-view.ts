import { z } from 'zod'

const score = z.number().finite().nullable()
const pooled = z.object({ agreement: score, macroF1: score, pairedDurationMs: z.number().nonnegative() })
/** A bounded UI projection of the retained versioned report; unknown versions fail closed. */
export const reportViewSchema = z.object({
  version: z.literal('processed-backtest-report-v1'), status: z.literal('insufficient_evidence'),
  datasetHash: z.string(), protocolHash: z.string(), manifestHash: z.string(), evaluatorBuildHash: z.string(),
  split: z.enum(['tuning', 'validation', 'holdout']), evidence: z.string(), holdoutUse: z.number(),
  protocol: z.object({ mode: z.enum(['comparison', 'stage_replay']) }),
  calibration: z.object({ source: z.literal('explicit_assumption'), quality: z.number() }),
  limitations: z.array(z.string()),
  stageNightSummary: z.array(z.object({ baseline: z.string(), candidate: z.string(), baselineHash: z.string(), candidateHash: z.string(),
    totalNights: z.number(), scoredNights: z.number(), unscoredNights: z.number(), coverageReducedNights: z.number(),
    improvedAgreementNights: z.number(), regressedAgreementNights: z.number(), unchangedAgreementNights: z.number(),
    equalNightMeanAgreementDifference: score,
    pooledCommonSupport: z.object({ baseline: pooled, candidate: pooled }),
    uncertainty: z.object({ status: z.enum(['not_requested', 'insufficient_nights', 'degenerate', 'estimated']),
      interval: z.object({ lower: z.number().finite(), upper: z.number().finite() }).nullable(), limitations: z.array(z.string()) }),
  })).max(3),
})

/** Numerical scores describe original readings, regardless of candidate parameters. */
export const numericReportViewSchema = z.object({
  nights: z.array(z.object({
    cohortId: z.string(),
    evaluations: z.array(z.object({
      label: z.enum(['default', 'current', 'candidate']), configHash: z.string(),
      windows: z.array(z.object({
        startMs: z.number().finite(), endMs: z.number().finite(), observationCount: z.number().int().nonnegative(),
        numeric: z.array(z.object({
          metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1']),
          status: z.enum(['compared', 'no_reference', 'no_overlap', 'incompatible']),
          metrics: z.object({ mae: score, medianAbsoluteError: score, p95AbsoluteError: score, signedBias: score }).nullable(),
          pairedCount: z.number().int().nonnegative(), referenceCoverage: score, outputCoverage: score,
          unmatchedReferences: z.number().int().nonnegative(), unmatchedObservations: z.number().int().nonnegative(),
          exclusions: z.record(z.string(), z.number().int().nonnegative()),
        })).max(3),
      })).max(60),
    })).max(3),
  })).max(60),
})
export type NumericReportView = z.infer<typeof numericReportViewSchema>

const duration = z.number().finite().nonnegative()
const stage = z.enum(['wake', 'light', 'deep', 'rem'])
const matrixRow = z.object({ wake: duration, light: duration, deep: duration, rem: duration })
const stageScore = pooled.extend({
  confusionMs: z.object({ wake: matrixRow, light: matrixRow, deep: matrixRow, rem: matrixRow }),
  perStage: z.array(z.object({ stage, referenceMs: duration, predictedMs: duration, precision: score, recall: score, f1: score })).length(4),
})
const ownSupport = z.object({ outputMs: duration, pairedMs: duration, referenceMs: duration, agreement: score, outputCoverage: score, referenceCoverage: score })
export const stageReportViewSchema = z.object({ stageNightSummary: z.array(z.object({
  baseline: z.string(), candidate: z.string(), baselineHash: z.string(), candidateHash: z.string(),
  pooledCommonSupport: z.object({ baseline: stageScore, candidate: stageScore }),
  nights: z.array(z.object({
    cohortId: z.string(), evaluationDurationMs: duration,
    commonSupport: z.object({ baseline: stageScore, candidate: stageScore }),
    ownSupport: z.object({ baseline: ownSupport, candidate: ownSupport }),
    commonAgreementDifference: score, commonMacroF1Difference: score, coverageReduced: z.boolean(),
  })).max(60),
})).max(3) })
export type StageReportView = z.infer<typeof stageReportViewSchema>
export type StageScoreView = z.infer<typeof stageScore>
