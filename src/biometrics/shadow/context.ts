import { shadowContextPolicySchema as policySchema } from './execution-policy'
import type Database from 'better-sqlite3'
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { z } from 'zod'
import { activeSleeperSides } from '../../lib/singleSleeper'

const sideSchema = z.object({ side: z.enum(['left', 'right']), away_mode: z.union([z.literal(0), z.literal(1)]) })
const bedSchema = z.object({ bed_mode: z.enum(['two', 'solo-left', 'solo-right']) })
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function presence(path: string, at: number, policy: z.infer<typeof policySchema>) {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > policy.maximumPresenceBytes || at < before.mtimeMs || at - before.mtimeMs > policy.presenceStaleMs) return null
    const bytes = Buffer.alloc(policy.maximumPresenceBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    if (length > policy.maximumPresenceBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null
    const state = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))))
    return state?.version === 1 ? state : null
  }
  catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}
function occupied(state: Record<string, unknown> | null, side: string, at: number, stale: number) {
  const row = object(state?.[side])
  if (typeof row?.vitals_presence !== 'boolean' || typeof row.vitals_evidence_ts !== 'number') return null
  const age = at - row.vitals_evidence_ts * 1000
  return Number.isFinite(age) && age >= 0 && age <= stale ? row.vitals_presence : null
}
function pumpEvidence(raw: unknown) {
  const side = object(raw), nested = object(side?.pump)
  if (!side) return false
  const values = [...['pumpRpm', 'pump_rpm', 'pumpRPM', 'rpm', 'pumpDuty', 'pump_duty', 'duty'].map(key => side[key]),
    ...['rpm', 'duty', 'power'].map(key => nested?.[key])]
  return values.some(value => (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && value.length <= 32 && Number.isFinite(Number(value))))
}

/** Current committed evidence for this shadow attempt, not an attestation of
 * the active Python process's independently cached view. Host qualification
 * must account for that timing difference. Missing context stays unknown. */
export class ShadowContextReader {
  private readonly policy: z.infer<typeof policySchema>
  private pumpAt: { left: number | null, right: number | null } = { left: null, right: null }
  private lastArrival = -1
  constructor(private readonly db: Database.Database, private readonly presencePath: string,
    policy: unknown, private readonly assertDatabaseCurrent: () => void) {
    this.policy = policySchema.parse(policy)
    if (!db.readonly && db.pragma('query_only', { simple: true }) !== 1) throw new Error('Shadow context requires read-only configuration')
  }

  private checkIdentity() {
    const checked: unknown = this.assertDatabaseCurrent()
    if (checked !== undefined) {
      void Promise.resolve(checked).catch(() => {})
      throw new Error('Shadow context identity check must be synchronous')
    }
  }

  snapshot(frame: Record<string, unknown>, observedAtMs: number) {
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || observedAtMs < this.lastArrival) throw new Error('Shadow context arrival clock regressed')
    this.lastArrival = observedAtMs
    // Replacement is an attempt failure, not merely missing settings.
    this.checkIdentity()
    let activeSides: ('left' | 'right')[] | null = null
    try {
      activeSides = this.db.transaction(() => {
        const sides = z.array(sideSchema).length(2).parse(this.db.prepare('SELECT side, away_mode FROM side_settings LIMIT 3').all())
        if (new Set(sides.map(row => row.side)).size !== 2) throw new Error('Ambiguous side settings')
        const bed = bedSchema.parse(this.db.prepare('SELECT bed_mode FROM device_settings WHERE id = 1').get())
        return activeSleeperSides({ bedMode: bed.bed_mode,
          left: { awayMode: sides.find(row => row.side === 'left')?.away_mode },
          right: { awayMode: sides.find(row => row.side === 'right')?.away_mode } })
      })()
    }
    catch { /* Missing/corrupt settings are unknown, never an invented two-sleeper default. */ }
    const state = presence(this.presencePath, observedAtMs, this.policy)
    this.checkIdentity()
    if (frame.type === 'frzHealth') {
      for (const side of ['left', 'right'] as const) {
        // An incomplete update invalidates prior knowledge for that side.
        this.pumpAt[side] = pumpEvidence(frame[side]) ? observedAtMs : null
      }
    }
    return { activeSides, leftOccupied: occupied(state, 'left', observedAtMs, this.policy.presenceStaleMs),
      rightOccupied: occupied(state, 'right', observedAtMs, this.policy.presenceStaleMs),
      pumpContextKnown: Object.values(this.pumpAt).every(at => at !== null && observedAtMs - at <= this.policy.pumpStaleMs) }
  }
}
