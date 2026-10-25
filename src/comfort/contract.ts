import { z } from 'zod'

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
)

export const comfortConfigSchema = z.object({
  mode: z.enum(['off', 'preview', 'active']),
  minimumF: z.number().int().min(55).max(110),
  maximumF: z.number().int().min(55).max(110),
  sensorAware: z.boolean().optional(),
  followBedtime: z.boolean().optional(),
}).strict().refine(config => config.minimumF <= config.maximumF, 'Minimum must not exceed maximum')

export const comfortStateSchema = z.object({
  config: comfortConfigSchema,
  offsetF: z.number().int().min(-3).max(3),
  feedbackThrough: z.union([z.literal(''), localDate]),
  learnedSession: z.string().max(500),
  pausedUntil: timestamp,
  lastAppliedAt: timestamp,
  lastTargetF: z.number().min(55).max(110).nullable(),
  lastSegment: z.string().max(1000),
}).strict()

export const comfortFeedbackSchema = z.object({
  date: localDate,
  comfort: z.enum(['warm', 'cold', 'comfortable']),
}).strict()

export const comfortDecisionSchema = z.object({
  eligible: z.boolean(),
  baselineF: z.number().nullable(),
  proposedF: z.number().nullable(),
  reason: z.string(),
  retainPreviousLease: z.boolean(),
  pauseRequired: z.boolean(),
})

export const comfortEventSchema = z.object({
  at: timestamp,
  kind: z.enum(['preview', 'configuration', 'feedback', 'manual_pause']),
  session: z.string().nullable(),
  message: z.string(),
  proposedF: z.number().nullable(),
  reportedF: z.number().nullable(),
  eligible: z.boolean(),
  deviceObservedAt: timestamp.nullable(),
  presenceObservedAt: timestamp.nullable(),
  owner: z.enum(['manual', 'run-once', 'autopilot', 'schedule']).nullable(),
})
export type ComfortEvent = z.infer<typeof comfortEventSchema>

export const comfortStatusSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: timestamp,
  side: z.enum(['left', 'right']),
  timezone: z.string().nullable(),
  deviceDate: localDate.nullable(),
  state: comfortStateSchema.nullable(),
  evaluatedAt: timestamp.nullable(),
  decision: comfortDecisionSchema.nullable(),
  fault: z.string().nullable(),
  history: z.array(comfortEventSchema),
  runtime: z.enum(['running', 'stopped']),
  activation: z.object({
    available: z.literal(false),
    reason: z.literal('Hardware qualification and reviewed Preview nights are pending.'),
  }),
  features: z.object({ sensorAware: z.literal(false), followBedtime: z.literal(false) }),
})
export type ComfortStatus = z.infer<typeof comfortStatusSchema>
