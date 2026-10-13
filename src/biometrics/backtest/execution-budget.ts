import { z } from 'zod'

/** Trusted deployment settings, never an experiment/configuration or RPC field.
 * These ceilings permit qualification of whole nights; they do not enable a
 * worker host or replace ongoing resource admission and lease fencing.
 */
export const replayBudgetSchema = z.object({
  jobWallMs: z.number().int().min(1000).max(48 * 60 * 60 * 1000),
  waveformWallMs: z.number().int().min(1000).max(60 * 60 * 1000),
  waveformCpuSeconds: z.number().int().min(1).max(3600),
}).strict().refine(budget => budget.waveformWallMs <= budget.jobWallMs
  && budget.waveformCpuSeconds * 1000 <= budget.waveformWallMs,
'Waveform CPU and wall budgets must fit within the job budget')
export type ReplayBudget = z.infer<typeof replayBudgetSchema>
