import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as configSchema from '@/src/db/schema'
import type * as bioSchema from '@/src/db/biometrics-schema'
import { ProfileStore } from './store'
import { recoverRuntimeIntent } from './recovery'
import { deliverRuntimeOutbox, reconcileActivation, repairCurrentRuntimeProjections } from './runtime'

type ConfigDB = BetterSQLite3Database<typeof configSchema>
type BioDB = BetterSQLite3Database<typeof bioSchema>

/** Bounded startup/recovery pass. One failure must not suppress the other side
 * or a later retry. No hardware commands, numerical work or fabricated receipts. */
export function tickBiometricRuntime(configDb: ConfigDB, bioDb: BioDB, now = Date.now()) {
  const errors: string[] = []
  const attempt = (name: string, operation: () => unknown) => {
    try {
      operation()
    }
    catch {
      errors.push(name)
    }
  }
  const profiles = new ProfileStore(configDb, () => now)
  for (const side of ['left', 'right'] as const) attempt(`migration:${side}`, () => profiles.migrateLegacy(side))
  for (const side of ['left', 'right'] as const) attempt(`intent-recovery:${side}`, () => recoverRuntimeIntent(configDb, side, now))
  attempt('projection-repair', () => repairCurrentRuntimeProjections(configDb, bioDb, now))
  attempt('outbox-delivery', () => deliverRuntimeOutbox(configDb, bioDb, now))
  for (const side of ['left', 'right'] as const) attempt(`reconcile:${side}`, () => reconcileActivation(configDb, bioDb, side, now))
  return { errors }
}

interface Host { timer: ReturnType<typeof setInterval>, tick: () => void }
const shared = globalThis as typeof globalThis & { __biometricRuntimeHost?: Host }
export function startBiometricRuntime(configDb: ConfigDB, bioDb: BioDB) {
  if (shared.__biometricRuntimeHost) return
  let previousError = ''
  const tick = () => {
    const result = tickBiometricRuntime(configDb, bioDb)
    const signature = result.errors.join(', ')
    if (signature && signature !== previousError) console.warn(`[biometrics] Runtime coordination will retry: ${signature}`)
    previousError = signature
  }
  const timer = setInterval(tick, 5000)
  timer.unref()
  shared.__biometricRuntimeHost = { timer, tick }
  tick()
}
export function stopBiometricRuntime() {
  if (shared.__biometricRuntimeHost) clearInterval(shared.__biometricRuntimeHost.timer)
  delete shared.__biometricRuntimeHost
}
