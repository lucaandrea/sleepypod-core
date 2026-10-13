import { z } from 'zod'
import { shadowPlanSchema, shadowExpectedBindingsSchema } from './store'
import { shadowExecutionPolicySchema } from './execution-policy'

export const submitShadowSchema = z.object({
  plan: shadowPlanSchema.safeExtend({ candidateRevisionId: z.string().uuid().nullable(),
    expectedBindings: shadowExpectedBindingsSchema, execution: shadowExecutionPolicySchema }),
  idempotencyKey: z.string().min(1).max(200),
}).strict()

