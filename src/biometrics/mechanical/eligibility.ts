import type Database from 'better-sqlite3'
import { z } from 'zod'
import { MECHANICAL_CONTEXT_VERSION } from './context'
import { mechanicalWindowProof } from './proof'
import { readMechanicalSnapshot } from './snapshot'

const inputSchema = z.object({ timestampBasis: z.literal('firmware_event_time_v1'),
  mechanicalContext: z.literal(MECHANICAL_CONTEXT_VERSION), sourceSide: z.enum(['left', 'right']) })
const vitalSchema = z.object({ side: z.enum(['left', 'right']), run_side: z.enum(['left', 'right']),
  timestamp: z.number().int().positive(), heart_rate: z.number().finite().nullable(),
  breathing_rate: z.number().finite().nullable(), hrv: z.number().finite().nullable(),
  quality_score: z.number().min(0).max(1), quality_count: z.literal(1),
  quality_side: z.enum(['left', 'right']), quality_timestamp: z.number().int(),
  flags: z.string().max(8192), input_identity: z.string().max(4096), kind: z.literal('live') })

/** Only fresh, proven live rows in the current quiet interval may drive rules.
 * Historical/legacy observations remain visible but never acquire new proof. */
export function isMechanicallyQualifiedVital(database: Database.Database, id: number, now: number): boolean {
  try {
    return database.transaction(() => {
      const snapshot = readMechanicalSnapshot(database, now)
      const state = snapshot?.state
      if (!state || state.reasons.length || !state.spanId || state.confirmedThroughMs === null
        || now >= state.validUntilMs || state.confirmedThroughMs > now) return false
      const row = vitalSchema.parse(database.prepare(`SELECT v.*, r.side AS run_side, r.kind,
        CASE WHEN length(CAST(r.input_identity AS BLOB)) <= 4096 THEN r.input_identity END AS input_identity,
        (SELECT COUNT(*) FROM vitals_quality q WHERE q.vitals_id=v.id) AS quality_count,
        q.side AS quality_side, q.timestamp AS quality_timestamp, q.quality_score,
        CASE WHEN length(CAST(q.flags AS BLOB)) <= 8192 THEN q.flags END AS flags
        FROM vitals v JOIN biometric_processing_runs r ON r.id=v.processing_run_id
        JOIN vitals_quality q ON q.vitals_id=v.id WHERE v.id=? LIMIT 1`).get(id))
      inputSchema.parse(JSON.parse(row.input_identity))
      const timestampMs = row.timestamp * 1000
      if (!Number.isSafeInteger(timestampMs) || timestampMs > now || now - timestampMs > 300_000
        || row.side !== row.run_side || row.side !== row.quality_side || row.timestamp !== row.quality_timestamp) return false
      const proof = mechanicalWindowProof(JSON.parse(row.flags), { timestampMs,
        heartRate: row.heart_rate, breathingRate: row.breathing_rate, hrv: row.hrv })
      return proof.epoch === state.epoch && proof.spanId === state.spanId && proof.endMs <= state.confirmedThroughMs
        && snapshot.spans.some(span => span.id === proof.spanId && span.epoch === proof.epoch
          && span.startMs <= proof.startMs && span.endMs >= proof.endMs)
    })()
  }
  catch { return false }
}
