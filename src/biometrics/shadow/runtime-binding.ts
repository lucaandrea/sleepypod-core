import type Database from 'better-sqlite3'
import { z } from 'zod'
import { configHash } from '../algorithms/canonical'
import { manifestHash, validateConfig } from '../algorithms/registry'
import { runtimePayloadSchema } from '../profiles/runtime'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const expectedSchema = z.object({ generation: integer.positive(), resolvedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const receiptSchema = z.object({ generation: integer, applied_hash: z.string(), state: z.literal('applied'),
  effective_sample_time_ms: integer, heartbeat_at_ms: integer })
const sides = ['left', 'right'] as const
const components = ['heart_rate', 'breathing_rate', 'hrv_index'] as const

/** Read-only observation of both physical-channel baselines. No default-config
 * fallback: an unacknowledged channel cannot establish prospective admission.
 * The aggregate uses the oldest heartbeat so the installed qualification's age
 * limit applies to every numerical component on both sides. */
export function shadowRuntimeBindingReader(configDb: Database.Database, bioDb: Database.Database, options: {
  side: 'left' | 'right'
  expected: Record<'left' | 'right', { generation: number, resolvedHash: string }>
  assertCurrent: () => void
  now?: () => number
}) {
  const expected = z.object({ left: expectedSchema, right: expectedSchema }).strict().parse(options.expected)
  const side = z.enum(sides).parse(options.side), now = options.now ?? Date.now, guard = options.assertCurrent
  const check = () => {
    for (const db of [configDb, bioDb]) {
      if (!db.open || (!db.readonly && db.pragma('query_only', { simple: true }) !== 1)) throw new Error('Shadow runtime observation requires read-only databases')
    }
    const result: unknown = guard()
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {})
      throw new Error('Shadow database identity guard must be synchronous')
    }
  }
  check()
  return () => {
    check()
    const at = integer.parse(now())
    const heartbeats: number[] = []
    configDb.transaction(() => bioDb.transaction(() => {
      for (const channel of sides) {
        const target = expected[channel]
        const binding = configDb.prepare('SELECT generation FROM biometric_profile_bindings WHERE side = ?').get(channel) as { generation: number } | undefined
        if (binding?.generation !== target.generation) throw new Error('Shadow runtime desired generation changed')
        const event = configDb.prepare('SELECT next_hash FROM biometric_activation_events WHERE side = ? AND generation = ?').get(channel, target.generation) as { next_hash: string } | undefined
        if (event?.next_hash !== target.resolvedHash) throw new Error('Shadow runtime desired configuration changed')
        const projection = bioDb.prepare(`SELECT resolved_hash, boundary, CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload ELSE NULL END AS payload
          FROM biometric_runtime_configs WHERE side = ? AND generation = ?`).get(channel, target.generation) as { resolved_hash: string, boundary: string, payload: string | null } | undefined
        if (!projection?.payload) throw new Error('Shadow runtime projection missing or oversized')
        const payload = runtimePayloadSchema.parse(JSON.parse(projection.payload))
        if (payload.side !== channel || payload.generation !== target.generation || payload.manifestHash !== manifestHash
          || payload.resolvedHash !== target.resolvedHash || projection.resolved_hash !== target.resolvedHash
          || payload.boundary !== projection.boundary || configHash(validateConfig(payload.resolved)) !== target.resolvedHash) throw new Error('Shadow runtime projection mismatch')
        for (const component of components) {
          // Read latest intent, including pending/failed generations; never fall
          // back to an older applied receipt after a replacement is announced.
          const receipt = receiptSchema.parse(bioDb.prepare(`SELECT generation, applied_hash, state, effective_sample_time_ms, heartbeat_at_ms
            FROM biometric_runtime_receipts WHERE side = ? AND component = ? ORDER BY generation DESC LIMIT 1`).get(channel, component))
          if (receipt.generation !== target.generation || receipt.applied_hash !== target.resolvedHash
            || receipt.effective_sample_time_ms > at || receipt.heartbeat_at_ms > at
            || receipt.heartbeat_at_ms < receipt.effective_sample_time_ms) throw new Error('Shadow runtime receipt mismatch or clock skew')
          heartbeats.push(receipt.heartbeat_at_ms)
        }
      }
    })())()
    check()
    return { side, ...expected[side], appliedHash: expected[side].resolvedHash,
      appliedGeneration: expected[side].generation, state: 'applied' as const, heartbeatAtMs: Math.min(...heartbeats) }
  }
}
