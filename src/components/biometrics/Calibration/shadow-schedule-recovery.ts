import { z } from 'zod'
import { preparedShadowPlanSchema } from '@/src/biometrics/shadow/preparation-contracts'

const recoverySchema = z.object({ version: z.literal(1), prepared: preparedShadowPlanSchema,
  idempotencyKey: z.string().regex(/^[a-f0-9]{48}$/) }).strict().refine(value =>
  Number.isFinite(new Date(value.prepared.plan.startMs).getTime())
  && Number.isFinite(new Date(value.prepared.plan.endMs).getTime()), 'Invalid display window')
export type ShadowScheduleRecovery = z.infer<typeof recoverySchema>
const key = (side: 'left' | 'right') => `sleepypod.shadow-schedule.v1.${side}`
const maximumBytes = 65536

/** Same-origin, same-tab recovery only; contains no reference records or waveforms. */
export function readShadowScheduleRecovery(storage: Storage, side: 'left' | 'right') {
  const text = storage.getItem(key(side))
  if (text === null) return undefined
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error('Oversized scheduling recovery record')
  const value = recoverySchema.parse(JSON.parse(text))
  if (value.prepared.plan.side !== side) throw new Error('Scheduling recovery side mismatch')
  return value
}
export function saveShadowScheduleRecovery(storage: Storage, side: 'left' | 'right', value: ShadowScheduleRecovery) {
  const text = JSON.stringify(recoverySchema.parse(value))
  if (value.prepared.plan.side !== side || new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error('Invalid scheduling recovery record')
  const previous = readShadowScheduleRecovery(storage, side)
  if (previous && JSON.stringify(previous) !== text) throw new Error('Unresolved scheduling request already exists')
  storage.setItem(key(side), text)
  if (storage.getItem(key(side)) !== text) throw new Error('Scheduling recovery was not saved')
}
export function clearShadowScheduleRecovery(storage: Storage, side: 'left' | 'right') {
  storage.removeItem(key(side))
  if (storage.getItem(key(side)) !== null) throw new Error('Scheduling recovery was not cleared')
}
