import { z } from 'zod'
import type { ShadowStore } from './store'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const shadowRunDescriptorSchema = z.object({
  id: z.string().uuid(), side: z.enum(['left', 'right']), subjectId: z.string(),
  state: z.enum(['pending', 'running', 'completed', 'stopped', 'failed']),
  planHash: hash, candidateConfigHash: hash, activeConfigHash: hash,
  candidateRevisionId: z.string().uuid().nullable(), candidateIdentitySaved: z.boolean(),
  startMs: integer, endMs: integer, createdAtMs: integer, endedAtMs: integer.nullable(),
  heartbeatAtMs: integer.nullable(), reason: z.string().nullable(), pointCount: integer, byteCount: integer,
  workerReceiptAvailable: z.boolean(),
}).strict()
export const shadowRunPageSchema = z.object({ items: z.array(shadowRunDescriptorSchema).max(50), nextCursor: z.string().uuid().nullable() }).strict()

/** Public metadata excludes storage paths, waveforms and worker transport data. */
export function describeShadowRun(run: ReturnType<ShadowStore['get']>) {
  return shadowRunDescriptorSchema.parse({ id: run.id, side: run.side, subjectId: run.plan.subjectId, state: run.state,
    planHash: run.plan_hash, candidateConfigHash: run.plan.candidateConfigHash, activeConfigHash: run.plan.activeConfigHash,
    candidateRevisionId: run.plan.candidateRevisionId ?? null, candidateIdentitySaved: run.plan.candidateRevisionId !== undefined,
    startMs: run.plan.startMs, endMs: run.plan.endMs, createdAtMs: run.created_at_ms, endedAtMs: run.ended_at_ms,
    heartbeatAtMs: run.heartbeat_at_ms, reason: run.reason, pointCount: run.point_count, byteCount: run.byte_count,
    workerReceiptAvailable: run.workerReceipt !== null })
}
