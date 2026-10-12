import { z } from 'zod'

export const nightBootstrapSchema = z.object({
  version: z.literal('paired-night-percentile-v1'), seed: z.string().min(1).max(64),
  resamples: z.number().int().min(200).max(5000), minimumNights: z.number().int().min(3).max(60),
}).strict()
export type NightBootstrapPolicy = z.infer<typeof nightBootstrapSchema>

