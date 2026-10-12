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
