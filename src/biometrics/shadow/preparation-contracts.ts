import { z } from 'zod'
import { shadowPlanSchema } from './plan-contracts'
import { shadowExecutionPolicySchema } from './execution-policy'
import { submitShadowSchema } from './submission-contracts'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const shadowPlanTemplateSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(200),
  qualificationHash: z.string().regex(/^[a-f0-9]{64}$/),
  maximumWindowMs: time.positive().max(7 * 86400000),
  execution: shadowExecutionPolicySchema, monitoring: shadowPlanSchema.shape.monitoring,
  joining: shadowPlanSchema.shape.joining.unwrap(), metrics: shadowPlanSchema.shape.metrics,
  windowIbiWindowMs: shadowPlanSchema.shape.windowIbiWindowMs,
  maximumPoints: shadowPlanSchema.shape.maximumPoints, maximumBytes: shadowPlanSchema.shape.maximumBytes,
}).strict().refine(template => template.maximumWindowMs + template.joining.drainGraceMs <= template.execution.budgets.wallMs,
  'Shadow template window and drain exceed worker wall budget')
export const prepareShadowRequestSchema = z.object({ templateId: z.string().min(1).max(80), side: z.enum(['left', 'right']),
  subjectId: z.string().min(1).max(200), candidateRevisionId: z.string().uuid().nullable(), startMs: time, endMs: time }).strict()
export const preparedShadowPlanSchema = z.object({ status: z.literal('prepared_not_admitted'), plan: submitShadowSchema.shape.plan,
  planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const shadowTemplatePageSchema = z.object({ items: z.array(z.object({ id: shadowPlanTemplateSchema.shape.id,
  label: shadowPlanTemplateSchema.shape.label, maximumWindowMs: shadowPlanTemplateSchema.shape.maximumWindowMs }).strict()).max(8) }).strict()
