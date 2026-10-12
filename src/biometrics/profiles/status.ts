import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { activationEventSchema } from './history'
import { runtimeHealth, runtimeHealthSchema } from './health'
import { RUNTIME_COMPONENTS } from './runtime'

export const activationStatusSchema = z.object({
  desiredGeneration: z.number().int(), isCurrent: z.boolean(), event: activationEventSchema.nullable(),
  deliveryState: z.enum(['pending', 'delivered', 'failed']).nullable(),
  observedState: z.enum(['unreported', 'pending_delivery', 'pending_boundary', 'applied', 'failed']),
  receiptHealth: runtimeHealthSchema,
  receipts: z.array(z.object({ component: z.string(), generation: z.number().int(), appliedHash: z.string(),
    effectiveSampleTimeMs: z.number().nullable(), state: z.enum(['pending_boundary', 'applied', 'failed']),
    error: z.string().nullable(), heartbeatAtMs: z.number() })),
})

/** Observation only: polling never acknowledges a processor or writes intent. */
export function activationStatus(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>,
  side: 'left' | 'right', id?: string, now = Date.now()): z.infer<typeof activationStatusSchema> {
  const binding = configDb.select().from(configSchema.biometricProfileBindings).where(eq(configSchema.biometricProfileBindings.side, side)).get()
  const desiredGeneration = binding?.generation ?? 0
  const events = configSchema.biometricActivationEvents
  const event = configDb.select().from(events).where(and(eq(events.side, side), id ? eq(events.id, id) : eq(events.generation, desiredGeneration))).get()
  if (id && !event) throw new ReferenceInputError('NOT_FOUND', 'Activation event not found for this side')
  const delivery = event
    ? configDb.select().from(configSchema.biometricConfigOutbox).where(and(
        eq(configSchema.biometricConfigOutbox.side, side), eq(configSchema.biometricConfigOutbox.generation, event.generation))).get()
    : undefined
  const receipts = event
    ? bioDb.select().from(bioSchema.biometricRuntimeReceipts).where(and(
        eq(bioSchema.biometricRuntimeReceipts.side, side), eq(bioSchema.biometricRuntimeReceipts.generation, event.generation))).all()
        .filter(row => row.appliedHash === event.nextHash && RUNTIME_COMPONENTS.includes(row.component as typeof RUNTIME_COMPONENTS[number]))
    : []
  const allApplied = RUNTIME_COMPONENTS.every(component => receipts.some(row => row.component === component && row.state === 'applied' && row.effectiveSampleTimeMs !== null))
  const observedState = !event
    ? 'unreported'
    : delivery?.state === 'failed' || receipts.some(row => row.state === 'failed')
      ? 'failed'
      : delivery?.state !== 'delivered' ? 'pending_delivery' : allApplied ? 'applied' : 'pending_boundary'
  return { desiredGeneration, isCurrent: event?.generation === desiredGeneration, event: event ? activationEventSchema.parse(event) : null,
    deliveryState: delivery?.state ?? null, observedState, receiptHealth: runtimeHealth(receipts, now), receipts }
}
