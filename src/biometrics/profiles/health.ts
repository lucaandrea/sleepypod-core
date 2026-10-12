import { z } from 'zod'

// Numerical consumers heartbeat every 30 seconds after accepted frames.
// A stage view is retrospective and consumed on demand, so its receipt age
// cannot establish whether the continuous processor is healthy.
export const RUNTIME_HEARTBEAT_STALE_MS = 120000
export const runtimeHealthSchema = z.object({
  state: z.enum(['unreported', 'current', 'stale', 'failed', 'mixed_generations', 'clock_skew']),
  staleAfterMs: z.number(),
  components: z.array(z.object({ component: z.string(), generation: z.number().nullable(),
    state: z.enum(['unreported', 'current', 'stale', 'failed', 'pending_boundary', 'clock_skew']), ageMs: z.number().nullable() })),
})
interface Receipt { component: string, generation: number, appliedHash: string, state: string, heartbeatAtMs: number, effectiveSampleTimeMs: number | null }
export function runtimeHealth(receipts: Receipt[], now = Date.now()): z.infer<typeof runtimeHealthSchema> {
  const names = ['heart_rate', 'breathing_rate', 'hrv_index']
  const selected = names.map(component => receipts.filter(row => row.component === component)
    .sort((a, b) => b.generation - a.generation || b.heartbeatAtMs - a.heartbeatAtMs)[0])
  const components = names.map((component, index) => {
    const receipt = selected[index]
    if (!receipt) return { component, generation: null, state: 'unreported' as const, ageMs: null }
    const ageMs = now - receipt.heartbeatAtMs
    const state = receipt.state === 'failed'
      ? 'failed' as const
      : ageMs < 0
        ? 'clock_skew' as const
        : ageMs > RUNTIME_HEARTBEAT_STALE_MS
          ? 'stale' as const
          : receipt.state !== 'applied' || receipt.effectiveSampleTimeMs === null ? 'pending_boundary' as const : 'current' as const
    return { component, generation: receipt.generation, state, ageMs }
  })
  const identities = new Set(selected.filter(row => row !== undefined).map(row => `${row.generation}:${row.appliedHash}`))
  const state = components.some(row => row.state === 'failed')
    ? 'failed'
    : components.some(row => row.state === 'clock_skew')
      ? 'clock_skew'
      : components.some(row => row.state === 'unreported' || row.state === 'pending_boundary')
        ? 'unreported'
        : components.some(row => row.state === 'stale')
          ? 'stale'
          : identities.size > 1 ? 'mixed_generations' : 'current'
  return { state, staleAfterMs: RUNTIME_HEARTBEAT_STALE_MS, components }
}
