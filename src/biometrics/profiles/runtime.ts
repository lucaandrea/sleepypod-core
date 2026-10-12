import { and, asc, eq, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { configHash } from '../algorithms/canonical'
import { manifestHash, validateConfig } from '../algorithms/registry'
import { ReferenceInputError } from '../references/time'

export const runtimePayloadSchema = z.object({ schemaVersion: z.literal(1), side: z.enum(['left', 'right']), generation: z.number().int().positive(),
  revisionId: z.string().uuid().nullable(), manifestHash: z.string(), resolved: z.unknown(), resolvedHash: z.string(),
  boundary: z.enum(['immediate', 'next_session']) }).strict()
export const RUNTIME_COMPONENTS = ['heart_rate', 'breathing_rate', 'hrv_index', 'sleep_stages'] as const

/** Idempotent projection only; never writes canonical vitals or runtime receipts. */
export function projectRuntimeConfig(db: BetterSQLite3Database<typeof bioSchema>, raw: unknown, now = Date.now()) {
  const payload = runtimePayloadSchema.parse(raw)
  const resolved = validateConfig(payload.resolved)
  if (payload.manifestHash !== manifestHash || configHash(resolved) !== payload.resolvedHash) throw new ReferenceInputError('PROFILE_INCOMPATIBLE', 'Runtime payload does not match its validated engine and configuration')
  return db.transaction((tx) => {
    const existing = tx.select().from(bioSchema.biometricRuntimeConfigs).where(and(eq(bioSchema.biometricRuntimeConfigs.side, payload.side), eq(bioSchema.biometricRuntimeConfigs.generation, payload.generation))).get()
    if (existing) {
      if (existing.resolvedHash !== payload.resolvedHash || configHash(existing.payload) !== configHash(payload)) throw new ReferenceInputError('REVISION_CONFLICT', 'Runtime generation already contains a different immutable payload')
      return { side: payload.side, generation: payload.generation, alreadyProjected: true }
    }
    tx.insert(bioSchema.biometricRuntimeConfigs).values({ side: payload.side, generation: payload.generation,
      resolvedHash: payload.resolvedHash, payload, boundary: payload.boundary, createdAtMs: now }).run()
    return { side: payload.side, generation: payload.generation, alreadyProjected: false }
  }, { behavior: 'immediate' })
}

/** Two short independent DB transactions; never assumes cross-database atomicity. */
export function deliverRuntimeOutbox(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, now = Date.now()) {
  const outbox = configSchema.biometricConfigOutbox
  const pending = configDb.select().from(outbox).where(and(eq(outbox.state, 'pending'), lte(outbox.nextAttemptAtMs, now)))
    .orderBy(asc(outbox.createdAtMs), asc(outbox.generation)).limit(20).all()
  let delivered = 0, failed = 0
  for (const row of pending) {
    try {
      const payload = runtimePayloadSchema.parse(row.payload)
      if (payload.side !== row.side || payload.generation !== row.generation || payload.resolvedHash !== row.resolvedHash) throw new ReferenceInputError('PROFILE_INCOMPATIBLE', 'Outbox envelope and payload disagree')
      projectRuntimeConfig(bioDb, payload, now)
      configDb.update(outbox).set({ state: 'delivered', deliveredAtMs: now, attempts: row.attempts + 1, lastError: null })
        .where(eq(outbox.id, row.id)).run()
      delivered++
    }
    catch (error) {
      const permanent = error instanceof z.ZodError || error instanceof ReferenceInputError
        || (error instanceof Error && /^(Invalid |Unknown |Expected finite|JSON resource)/.test(error.message))
      configDb.transaction((tx) => {
        tx.update(outbox).set({ state: permanent ? 'failed' : 'pending', attempts: row.attempts + 1,
          nextAttemptAtMs: now + Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8)),
          lastError: permanent ? 'Incompatible or conflicting runtime payload' : 'Runtime database delivery failed; retry scheduled',
        }).where(eq(outbox.id, row.id)).run()
        if (permanent) tx.update(configSchema.biometricActivationEvents).set({ state: 'failed', reason: 'Runtime payload rejected during delivery', updatedAtMs: now })
          .where(and(eq(configSchema.biometricActivationEvents.side, row.side), eq(configSchema.biometricActivationEvents.generation, row.generation))).run()
      }, { behavior: 'immediate' })
      failed++
    }
  }
  return { delivered, failed }
}

/** Recreate authoritative projections after a biometric-history reset. */
export function repairCurrentRuntimeProjections(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, now = Date.now()) {
  let restored = 0
  for (const binding of configDb.select().from(configSchema.biometricProfileBindings).all()) {
    const row = configDb.select().from(configSchema.biometricConfigOutbox).where(and(eq(configSchema.biometricConfigOutbox.side, binding.side),
      eq(configSchema.biometricConfigOutbox.generation, binding.generation), eq(configSchema.biometricConfigOutbox.state, 'delivered'))).get()
    if (row) {
      const payload = runtimePayloadSchema.parse(row.payload)
      if (payload.side !== row.side || payload.generation !== row.generation || payload.resolvedHash !== row.resolvedHash) throw new ReferenceInputError('PROFILE_INCOMPATIBLE', 'Stored runtime envelope and payload disagree')
      try {
        if (!projectRuntimeConfig(bioDb, payload, now).alreadyProjected) restored++
      }
      catch (error) {
        if (!(error instanceof ReferenceInputError) || error.code !== 'REVISION_CONFLICT') throw error
        // Preserve the conflicting immutable row for diagnosis. Recovery will
        // publish a fresh audited generation on its next pass.
        configDb.update(configSchema.biometricConfigOutbox).set({ state: 'failed', lastError: 'Runtime projection conflicts with authoritative intent' })
          .where(eq(configSchema.biometricConfigOutbox.id, row.id)).run()
      }
    }
  }
  return restored
}

/** Only matching receipts for the desired generation can establish adoption. */
export function reconcileActivation(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, side: 'left' | 'right', now = Date.now()) {
  const binding = configDb.select().from(configSchema.biometricProfileBindings).where(eq(configSchema.biometricProfileBindings.side, side)).get()
  if (!binding) return null
  const event = configDb.select().from(configSchema.biometricActivationEvents).where(and(eq(configSchema.biometricActivationEvents.side, side), eq(configSchema.biometricActivationEvents.generation, binding.generation))).get()
  if (!event) return null
  const delivery = configDb.select().from(configSchema.biometricConfigOutbox).where(and(eq(configSchema.biometricConfigOutbox.side, side), eq(configSchema.biometricConfigOutbox.generation, binding.generation))).get()
  const receipts = bioDb.select().from(bioSchema.biometricRuntimeReceipts).where(and(eq(bioSchema.biometricRuntimeReceipts.side, side), eq(bioSchema.biometricRuntimeReceipts.generation, binding.generation))).all()
    .filter(row => row.appliedHash === event.nextHash && RUNTIME_COMPONENTS.includes(row.component as typeof RUNTIME_COMPONENTS[number]))
  const rejected = receipts.find(row => row.state === 'failed')
  const allApplied = RUNTIME_COMPONENTS.every(component => receipts.some(row => row.component === component && row.state === 'applied' && row.effectiveSampleTimeMs !== null))
  const state = delivery?.state === 'failed' || rejected
    ? 'failed'
    : delivery?.state !== 'delivered' ? 'pending_delivery' : allApplied ? 'applied' : 'pending_boundary'
  // Re-check desired generation inside the write transaction. A newer request
  // cannot be acknowledged by receipts read for an older request.
  return configDb.transaction((tx) => {
    const current = tx.select().from(configSchema.biometricProfileBindings).where(eq(configSchema.biometricProfileBindings.side, side)).get()
    if (current?.generation !== binding.generation) return null
    tx.update(configSchema.biometricActivationEvents).set({ state, reason: rejected ? 'Runtime component rejected configuration' : delivery?.state === 'failed' || event.action === 'fallback' ? event.reason : null,
      updatedAtMs: state === event.state ? event.updatedAtMs : now }).where(eq(configSchema.biometricActivationEvents.id, event.id)).run()
    return { side, generation: binding.generation, state, resolvedHash: event.nextHash, receipts }
  }, { behavior: 'immediate' })
}
