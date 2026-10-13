import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, dataHash } from '../algorithms/canonical'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = integer.positive()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const metric = z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'])
export const shadowPlanSchema = z.object({ schema: z.literal('biometric-shadow-plan-v1'), side: z.enum(['left', 'right']),
  candidateConfigHash: hash, activeConfigHash: hash, qualificationHash: hash, engineBuildHash: hash,
  startMs: integer, endMs: integer, maximumPoints: positive, maximumBytes: positive,
  metrics: z.array(metric).min(1).max(3),
}).strict().refine(plan => plan.endMs > plan.startMs && plan.endMs - plan.startMs <= 7 * 86400000
  && new Set(plan.metrics).size === plan.metrics.length, 'Invalid shadow window or metrics')
const reading = z.object({ value: z.number().finite().nullable(), quality: z.number().min(0).max(1) }).strict()
export const shadowSampleSchema = z.object({ sequence: integer, side: z.enum(['left', 'right']), timestampMs: integer, inputHash: hash,
  candidateConfigHash: hash, activeConfigHash: hash,
  readings: z.array(z.object({ metric, candidate: reading, active: reading }).strict()).min(1).max(3),
}).strict()
export const shadowStoragePolicySchema = z.object({ maximumRuns: positive, maximumPoints: positive, maximumBytes: positive }).strict()
type Plan = z.infer<typeof shadowPlanSchema>
interface RunRow {
  id: string
  plan_hash: string
  plan: string
  side: 'left' | 'right'
  state: 'pending' | 'running' | 'completed' | 'stopped' | 'failed'
  attempt_id: string | null
  lease_until_ms: number | null
  heartbeat_at_ms: number | null
  created_at_ms: number
  ended_at_ms: number | null
  reason: string | null
  point_count: number
  byte_count: number
}
export interface ShadowLease { runId: string, attemptId: string }

/** Storage only: accepts observations from a separately admitted shipped
 * processor. No algorithm imports, canonical writes, activation or hardware.
 * The host must verify qualification/build and enforce CPU/RSS before claim. */
export class ShadowStore {
  private readonly policy: z.infer<typeof shadowStoragePolicySchema>
  constructor(private readonly db: Database.Database, policy: unknown, private readonly now = Date.now) {
    this.policy = shadowStoragePolicySchema.parse(policy)
  }

  get(id: string) {
    const row = this.db.prepare('SELECT * FROM biometric_shadow_runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw new Error('Unknown shadow run')
    const plan = shadowPlanSchema.parse(JSON.parse(row.plan))
    if (dataHash(plan) !== row.plan_hash || row.side !== plan.side) throw new Error('Shadow plan integrity mismatch')
    return { ...row, plan }
  }

  create(raw: unknown, idempotencyKey: string) {
    const plan = shadowPlanSchema.parse(raw), planHash = dataHash(plan)
    z.string().min(1).max(200).parse(idempotencyKey)
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT id, plan_hash FROM biometric_shadow_runs WHERE idempotency_key = ?').get(idempotencyKey) as { id: string, plan_hash: string } | undefined
      if (previous) {
        if (previous.plan_hash !== planHash) throw new Error('Shadow idempotency conflict')
        return this.get(previous.id)
      }
      const now = this.now()
      if (plan.startMs < now) throw new Error('Shadow window must be prospective')
      if (plan.maximumPoints > this.policy.maximumPoints || plan.maximumBytes > this.policy.maximumBytes) throw new Error('Shadow plan exceeds storage policy')
      const count = (this.db.prepare('SELECT COUNT(*) AS count FROM biometric_shadow_runs').get() as { count: number }).count
      if (count >= this.policy.maximumRuns) throw new Error('Shadow run quota exceeded')
      const id = randomUUID()
      this.db.prepare(`INSERT INTO biometric_shadow_runs
        (id, idempotency_key, plan_hash, plan, side, state, created_at_ms) VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, idempotencyKey, planHash, canonicalJson(plan), plan.side, now)
      return this.get(id)
    }).immediate()
  }

  /** Admission is a trusted synchronous host check, never a client boolean. */
  claim(id: string, leaseMs: number, admit: (plan: Plan) => void): ShadowLease {
    z.number().int().min(1000).max(3600000).parse(leaseMs)
    return this.db.transaction(() => {
      const run = this.get(id), now = this.now()
      if (!['pending', 'running'].includes(run.state) || (run.state === 'running' && (run.lease_until_ms ?? 0) > now)) throw new Error('Shadow run unavailable')
      if (now < run.plan.startMs || now >= run.plan.endMs) throw new Error('Outside shadow window')
      if (this.db.prepare(`SELECT id FROM biometric_shadow_runs WHERE side = ? AND state = 'running' AND lease_until_ms > ? AND id != ?`).get(run.side, now, id)) throw new Error('Side already has an active shadow worker')
      // Pass a copy: an admission callback cannot mutate the frozen plan.
      const admitted: unknown = admit(structuredClone(run.plan))
      if (admitted !== undefined) {
        void Promise.resolve(admitted).catch(() => undefined)
        throw new Error('Shadow admission must complete synchronously')
      }
      const attemptId = randomUUID()
      this.db.prepare('UPDATE biometric_shadow_runs SET state = \'running\', attempt_id = ?, lease_until_ms = ?, heartbeat_at_ms = ? WHERE id = ?')
        .run(attemptId, Math.min(run.plan.endMs, now + leaseMs), now, id)
      return { runId: id, attemptId }
    }).immediate()
  }

  private current(lease: ShadowLease) {
    const run = this.get(lease.runId), now = this.now()
    if (run.state !== 'running' || run.attempt_id !== lease.attemptId || (run.lease_until_ms ?? 0) <= now || now >= run.plan.endMs) throw new Error('Stale shadow lease')
    return { run, now }
  }

  append(lease: ShadowLease, raw: unknown) {
    const sample = shadowSampleSchema.parse(raw), contentHash = dataHash(sample)
    return this.db.transaction(() => {
      const { run, now } = this.current(lease)
      if (sample.side !== run.side || sample.candidateConfigHash !== run.plan.candidateConfigHash || sample.activeConfigHash !== run.plan.activeConfigHash
        || sample.timestampMs < run.plan.startMs || sample.timestampMs >= run.plan.endMs || sample.timestampMs > now
        || sample.readings.length !== run.plan.metrics.length || new Set(sample.readings.map(row => row.metric)).size !== run.plan.metrics.length
        || sample.readings.some(row => !run.plan.metrics.includes(row.metric))) throw new Error('Shadow sample differs from frozen plan')
      const previous = this.db.prepare('SELECT content_hash FROM biometric_shadow_samples WHERE run_id = ? AND sequence = ?').get(run.id, sample.sequence) as { content_hash: string } | undefined
      if (previous) {
        if (previous.content_hash !== contentHash) throw new Error('Shadow sample idempotency conflict')
        return { state: 'already_recorded' as const }
      }
      const last = this.db.prepare('SELECT sequence, timestamp_ms FROM biometric_shadow_samples WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(run.id) as { sequence: number, timestamp_ms: number } | undefined
      if (sample.sequence !== (last ? last.sequence + 1 : 0) || (last && sample.timestampMs <= last.timestamp_ms)) throw new Error('Out-of-order shadow sample')
      const payload = canonicalJson({ ...sample, attemptId: lease.attemptId }), bytes = Buffer.byteLength(payload)
      const totals = this.db.prepare('SELECT COALESCE(SUM(point_count), 0) AS points, COALESCE(SUM(byte_count), 0) AS bytes FROM biometric_shadow_runs').get() as { points: number, bytes: number }
      if (run.point_count + 1 > run.plan.maximumPoints || run.byte_count + bytes > run.plan.maximumBytes
        || totals.points + 1 > this.policy.maximumPoints || totals.bytes + bytes > this.policy.maximumBytes) {
        this.db.prepare('UPDATE biometric_shadow_runs SET state = \'stopped\', reason = \'storage_quota\', ended_at_ms = ?, lease_until_ms = NULL WHERE id = ?').run(now, run.id)
        return { state: 'quota_reached' as const }
      }
      this.db.prepare('INSERT INTO biometric_shadow_samples VALUES (?, ?, ?, ?, ?, ?)').run(run.id, sample.sequence, sample.timestampMs, contentHash, payload, bytes)
      this.db.prepare('UPDATE biometric_shadow_runs SET point_count = point_count + 1, byte_count = byte_count + ?, heartbeat_at_ms = ? WHERE id = ?').run(bytes, now, run.id)
      return { state: 'recorded' as const }
    }).immediate()
  }

  /** Host/operator cancellation also works after a worker has disappeared or
   * the observation window has ended. Terminal evidence is preserved. */
  stop(id: string, reason: string) {
    z.string().min(1).max(500).parse(reason)
    return this.db.transaction(() => {
      this.get(id)
      this.db.prepare('UPDATE biometric_shadow_runs SET state = \'stopped\', reason = ?, ended_at_ms = ?, lease_until_ms = NULL WHERE id = ? AND state IN (\'pending\', \'running\')')
        .run(reason, this.now(), id)
      return this.get(id)
    }).immediate()
  }

  renew(lease: ShadowLease, leaseMs: number) {
    z.number().int().min(1000).max(3600000).parse(leaseMs)
    this.db.transaction(() => {
      const { run, now } = this.current(lease)
      this.db.prepare('UPDATE biometric_shadow_runs SET lease_until_ms = ?, heartbeat_at_ms = ? WHERE id = ?').run(Math.min(run.plan.endMs, now + leaseMs), now, run.id)
    }).immediate()
  }

  finish(lease: ShadowLease, state: 'completed' | 'stopped' | 'failed', reason: string) {
    z.enum(['completed', 'stopped', 'failed']).parse(state)
    z.string().min(1).max(500).parse(reason)
    this.db.transaction(() => {
      const { run, now } = this.current(lease)
      this.db.prepare('UPDATE biometric_shadow_runs SET state = ?, reason = ?, ended_at_ms = ?, lease_until_ms = NULL WHERE id = ?').run(state, reason, now, run.id)
    }).immediate()
  }
}
