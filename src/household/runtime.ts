import { sqlite } from '@/src/db'
import { HouseholdStore } from './store'
import { householdHttp } from './http'
const shared = globalThis as typeof globalThis & {
  __sleepypodHousehold?: {
    store: HouseholdStore
    publicAttempts: number
    windowStarted: number
  }
}
export function preparationEnabled() {
  return process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1'
}
export async function handleHouseholdRequest(request: Request) {
  if (!preparationEnabled())
    return Response.json({ error: { code: 'not_ready', message: 'Personal household preparation is not enabled on this controller.' } }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } })
  const runtime = shared.__sleepypodHousehold ??= { store: new HouseholdStore(sqlite), publicAttempts: 0, windowStarted: Date.now() }
  return householdHttp(request, {
    store: runtime.store,
    verifySoloConfiguration: (side) => {
      const row = sqlite.prepare('SELECT bed_mode, unused_zone_mode FROM device_settings LIMIT 1').get() as {
        bed_mode: string
        unused_zone_mode: string
      } | undefined
      return row?.bed_mode === `solo-${side}` && row.unused_zone_mode === 'follow'
    },
    allowPublicAttempt: () => {
      const now = Date.now()
      if (now - runtime.windowStarted >= 60000 || now < runtime.windowStarted) {
        runtime.windowStarted = now
        runtime.publicAttempts = 0
      }
      runtime.publicAttempts += 1
      return runtime.publicAttempts <= 30
    },
  })
}
