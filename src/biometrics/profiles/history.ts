import { and, desc, eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/schema'

export const activationEventSchema = z.object({
  id: z.string().uuid(), side: z.enum(['left', 'right']), generation: z.number().int(),
  action: z.enum(['activate', 'reset', 'rollback', 'migration', 'fallback']),
  previousRevisionId: z.string().nullable(), nextRevisionId: z.string().nullable(),
  previousHash: z.string(), nextHash: z.string(), evaluationId: z.string().nullable(), evidence: z.unknown(),
  requester: z.string(), state: z.enum(['saved', 'pending_delivery', 'pending_boundary', 'applied', 'failed']),
  reason: z.string().nullable(), createdAtMs: z.number(), updatedAtMs: z.number(),
})
export const activationHistorySchema = z.object({ items: z.array(activationEventSchema), nextGeneration: z.number().int().nullable() })

export function listActivationHistory(db: BetterSQLite3Database<typeof schema>, side: 'left' | 'right', beforeGeneration?: number) {
  const events = schema.biometricActivationEvents
  const rows = db.select().from(events).where(and(eq(events.side, side),
    beforeGeneration === undefined ? undefined : lt(events.generation, beforeGeneration)))
    .orderBy(desc(events.generation)).limit(51).all()
  const items = rows.slice(0, 50).map(row => activationEventSchema.parse(row))
  return { items, nextGeneration: rows.length > 50 ? items[items.length - 1].generation : null }
}
