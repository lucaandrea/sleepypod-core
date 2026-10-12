import { z } from 'zod'
export const traceRequestSchema = z.object({ id: z.string().uuid(), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: z.enum(['default', 'current', 'candidate']), cohortId: z.string().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(500).default(200),
}).strict()
export const tracePageSchema = z.object({ jobId: z.string().uuid(), contentHash: z.string(), configuration: z.enum(['default', 'current', 'candidate']),
  provenance: z.literal('versioned_stage_replay'), timestampBasis: z.literal('original_trace_before_reference_clock_offset'), clockOffsetMs: z.number(),
  totalItems: z.number().int(), offset: z.number().int(), limit: z.number().int(), downsampled: z.literal(false),
  items: z.array(z.object({ cohortId: z.string(), configurationHash: z.string(), revisionId: z.string().uuid().nullable(),
    windowStartMs: z.number(), windowEndMs: z.number(), startMs: z.number(), endMs: z.number(), stage: z.enum(['wake', 'light', 'deep', 'rem']) })),
  nextCursor: z.object({ offset: z.number().int(), contentHash: z.string() }).nullable(),
})
