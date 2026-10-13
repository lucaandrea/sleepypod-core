import { z } from 'zod'

/** Operator-reviewed criteria, frozen into the protocol before holdout access.
 * There are deliberately no production defaults or clinical accuracy claims. */
export const packageAccuracyPolicySchema = z.object({
  schema: z.literal('biometric-package-accuracy-policy-v1'),
  minimumMaeImprovement: z.number().finite().positive(),
  maximumNightMaeRegression: z.number().finite().nonnegative(),
  maximumNightP95Regression: z.number().finite().nonnegative(),
  maximumNightAbsoluteBiasIncrease: z.number().finite().nonnegative(),
  minimumCommonPairsPerNight: z.number().int().positive().max(100000),
  minimumReferenceCoverage: z.number().positive().max(1),
  maximumReferenceCoverageLoss: z.number().min(0).max(1),
  maximumLostTimestampFraction: z.number().min(0).max(1),
}).strict()
