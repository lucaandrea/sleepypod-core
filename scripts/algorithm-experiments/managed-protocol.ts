import { packagePreflightPlanSchema } from './preflight'
import { packageAccuracyPolicySchema } from './accuracy-policy'
import { z } from 'zod'
import { nightBootstrapSchema } from '../../src/biometrics/backtest/uncertainty-policy'
import { packageResourcePolicySchema } from './resource-assessment'

export const managedProtocolSchema = z.object({ schema: z.literal('biometric-managed-protocol-v1'),
  hardwareId: z.string().min(1).max(100), sampleRateHz: z.number().int().positive(), metricId: z.string().min(1).max(100),
  minimumQuality: z.number().min(0).max(1),
  alignment: z.object({ version: z.literal('reference-alignment-v1'), pointToleranceMs: z.number().int().min(0).max(300000),
    clockOffsetMs: z.number().int().min(-3600000).max(3600000), offsetSource: z.enum(['fixed', 'training']) }).strict(),
  accuracyPolicy: packageAccuracyPolicySchema.optional(), preflightPlan: packagePreflightPlanSchema.optional(),
  uncertainty: nightBootstrapSchema, resourcePolicy: packageResourcePolicySchema,
}).strict()
