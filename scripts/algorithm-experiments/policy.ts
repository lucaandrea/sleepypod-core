import { z } from 'zod'
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const experimentPolicySchema = z.object({ image: z.string().regex(/^sha256:[a-f0-9]{64}$/), maximumWallMs: positive.max(3600000),
  maximumMemoryBytes: positive, maximumProcesses: positive, maximumOutputBytes: positive, maximumInputBytes: positive,
}).strict()
