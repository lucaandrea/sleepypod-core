import { z } from 'zod'
import { shadowExecutionPolicySchema } from './execution-policy'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = integer.positive()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const metric = z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'])
const binding = z.object({ generation: positive, resolvedHash: hash }).strict()
export const shadowExpectedBindingsSchema = z.object({ left: binding, right: binding }).strict()
export const shadowMonitoringSchema = z.object({
  expectedIntervalMs: positive, maximumGapMs: positive, heartbeatStaleMs: positive,
  minimumCandidateCoverage: z.number().positive().max(1), maximumCoverageLoss: z.number().min(0).max(1), minimumQuality: z.number().min(0).max(1),
  alignment: z.object({ version: z.literal('reference-alignment-v1'), pointToleranceMs: integer.max(300000),
    clockOffsetMs: z.number().int().min(-3600000).max(3600000), offsetSource: z.enum(['fixed', 'training']) }).strict(),
}).strict()
export const shadowPlanSchema = z.object({ schema: z.literal('biometric-shadow-plan-v1'), side: z.enum(['left', 'right']),
  execution: shadowExecutionPolicySchema.optional(),
  // Absent on legacy evidence; null explicitly selects the shipped default.
  candidateRevisionId: z.string().uuid().nullable().optional(),
  expectedBindings: shadowExpectedBindingsSchema.optional(),
  subjectId: z.string().min(1).max(200), monitoring: shadowMonitoringSchema,
  windowIbiWindowMs: positive.max(86400000).optional(),
  joining: z.object({ maximumPendingPoints: positive.max(10000), maximumLatenessMs: positive.max(120000),
    drainGraceMs: positive.max(300000) }).strict().refine(value => value.drainGraceMs > value.maximumLatenessMs, 'Drain grace must exceed lateness').optional(),
  candidateConfigHash: hash, activeConfigHash: hash, qualificationHash: hash, engineBuildHash: hash,
  startMs: integer, endMs: integer, maximumPoints: positive, maximumBytes: positive,
  metrics: z.array(metric).min(1).max(3),
}).strict().refine(plan => plan.endMs > plan.startMs && plan.endMs - plan.startMs <= 7 * 86400000
  && Number.isSafeInteger(plan.endMs + (plan.joining?.drainGraceMs ?? 0))
  && (!plan.execution || (plan.joining !== undefined && plan.execution.sources.pollMs < plan.joining.maximumLatenessMs
    && plan.execution.heartbeatMs <= plan.monitoring.heartbeatStaleMs
    && plan.execution.configHashes[plan.side] === plan.candidateConfigHash))
  && new Set(plan.metrics).size === plan.metrics.length
  && (!plan.metrics.includes('window_ibi_variability_v1') || plan.windowIbiWindowMs !== undefined), 'Invalid shadow window or metrics')
