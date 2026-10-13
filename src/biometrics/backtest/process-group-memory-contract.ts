import { z } from 'zod'

export const processGroupMemorySchema = z.object({
  version: z.literal('process-group-rss-observations-v1'),
  scope: z.literal('sum_rss_of_replay_process_group'),
  attempts: z.number().int().nonnegative(), samples: z.number().int().nonnegative(),
  allSamplesAvailable: z.boolean(), peakObservedRssBytes: z.number().int().positive().nullable(),
  maximumObservationGapMs: z.number().finite().nonnegative(), intervalMs: z.literal(1000),
  exactKernelPeak: z.literal(false),
}).strict()
export type ProcessGroupMemory = z.infer<typeof processGroupMemorySchema>

