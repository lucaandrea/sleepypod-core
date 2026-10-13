import { z } from 'zod'
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const shadowChildBudgetsSchema = z.object({ cpuSeconds: positive.max(3600), addressSpaceBytes: positive,
  maximumRssBytes: positive, wallMs: positive.max(7 * 86400000 + 300000),
  acknowledgmentMs: positive.max(300000), idleMs: positive.max(300000),
  rssIntervalMs: positive.min(50).max(1000), rssTimeoutMs: positive.max(10000),
}).strict()
export const shadowFrameBudgetsSchema = z.object({ maximumFrames: positive.max(1000), maximumBytes: positive.max(32 * 1024 * 1024),
  maximumEventAgeMs: positive.max(120000), maximumFutureSkewMs: z.number().int().min(0).max(5000) }).strict()
export const shadowContextPolicySchema = z.object({ presenceStaleMs: positive.max(300000),
  pumpStaleMs: positive.max(300000), maximumPresenceBytes: positive.max(256 * 1024) }).strict()

/** Explicit ceilings, never production defaults. The reviewed qualification
 * must match the complete policy, including both physical channel configs. */
export const shadowExecutionPolicySchema = z.object({ version: z.literal('shadow-execution-policy-v1'),
  configHashes: z.object({ left: hash, right: hash }).strict(),
  maximumRecords: positive, maximumOutputs: positive, maximumCpuMs: positive, maximumInputBytes: positive, maximumOutputBytes: positive,
  budgets: shadowChildBudgetsSchema, leaseMs: positive.min(1000).max(3600000), heartbeatMs: positive.max(1000),
  sources: z.object({ pollMs: positive.min(10).max(1000), maximumActiveRows: positive.max(100),
    databaseBusyTimeoutMs: positive.max(1000), frames: shadowFrameBudgetsSchema, context: shadowContextPolicySchema }).strict(),
}).strict().refine(policy => policy.heartbeatMs * 3 <= policy.leaseMs, 'Heartbeat must fit the lease')
export type ShadowExecutionPolicy = z.infer<typeof shadowExecutionPolicySchema>
