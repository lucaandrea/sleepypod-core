import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type * as schema from '@/src/db/schema'
import type * as bioSchema from '@/src/db/biometrics-schema'
import { biometricActivationEvents as events, biometricConfigOutbox as outbox, biometricProfileBindings as bindings, sideSettings } from '@/src/db/schema'
import { defaultConfig, manifestHash } from '../algorithms/registry'
import { configHash } from '../algorithms/canonical'
import { ReferenceInputError } from '../references/time'
import { stageClassifierSchema } from '@/src/lib/sleep-stage-rules'
import { ProfileStore } from './store'
import { prepareVerifiedEvaluation, type PromotionBuild } from './evaluation-store'

export const activationIntentSchema = z.object({
  side: z.enum(['left', 'right']), action: z.enum(['activate', 'reset', 'rollback']),
  revisionId: z.string().uuid().nullable(), expectedGeneration: z.number().int().nonnegative(),
  expectedResolvedHash: z.string().regex(/^[a-f0-9]{64}$/), boundary: z.enum(['immediate', 'next_session']),
  requester: z.string().min(1).max(200), idempotencyKey: z.string().min(1).max(200),
  allowUnvalidated: z.literal(true),
}).strict()

export const validatedActivationIntentSchema = activationIntentSchema.omit({ allowUnvalidated: true }).extend({
  action: z.literal('activate'), revisionId: z.string().uuid(), evaluationId: z.string().uuid(),
  expectedReportHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const validatedActivationReviewSchema = validatedActivationIntentSchema.omit({ action: true, boundary: true, requester: true, idempotencyKey: true })

/** A point-in-time review only; application repeats every verification. */
export async function reviewValidatedActivation(db: BetterSQLite3Database<typeof schema>, bioDb: BetterSQLite3Database<typeof bioSchema>,
  raw: z.input<typeof validatedActivationReviewSchema>, resolveBuild: () => Promise<PromotionBuild>) {
  const input = validatedActivationReviewSchema.parse(raw)
  const verified = prepareVerifiedEvaluation(db, bioDb, input, await resolveBuild())
  verified.recheck()
  return { eligible: true as const }
}

function retryActivation(db: BetterSQLite3Database<typeof schema>, idempotencyKey: string, requestHash: string) {
  const existing = db.select().from(events).where(eq(events.idempotencyKey, idempotencyKey)).get()
  if (existing && existing.requestHash !== requestHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Activation idempotency key changed')
  return existing
}

export function requestManualActivation(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof activationIntentSchema>, now = Date.now()) {
  const input = activationIntentSchema.parse(raw)
  return commitActivationIntent(db, input, configHash(input), now)
}

/** Configuration is the only database written here. The short biometrics write
 * reservation prevents exposure/release/runtime changes across the config
 * commit; it is not a transaction committing writes to two databases. */
export function requestValidatedActivation(db: BetterSQLite3Database<typeof schema>, bioDb: BetterSQLite3Database<typeof bioSchema>,
  raw: z.input<typeof validatedActivationIntentSchema>, build: PromotionBuild, now = Date.now()) {
  const input = validatedActivationIntentSchema.parse(raw)
  const requestHash = configHash(input)
  const existing = retryActivation(db, input.idempotencyKey, requestHash)
  if (existing) return existing
  const verified = prepareVerifiedEvaluation(db, bioDb, input, build)
  const intent = activationIntentSchema.strip().parse({ ...input, allowUnvalidated: true })
  return bioDb.transaction(() => commitActivationIntent(db, intent, requestHash, now,
    { ...verified, evaluationId: input.evaluationId }), { behavior: 'immediate' })
}

/** Retry before artifact/build access. Recheck again after the async probe so
 * concurrent identical requests still create only one activation event. */
export async function requestValidatedActivationWithBuild(db: BetterSQLite3Database<typeof schema>, bioDb: BetterSQLite3Database<typeof bioSchema>,
  raw: z.input<typeof validatedActivationIntentSchema>, resolveBuild: () => Promise<PromotionBuild>, now = Date.now()) {
  const input = validatedActivationIntentSchema.parse(raw)
  const existing = retryActivation(db, input.idempotencyKey, configHash(input))
  if (existing) return existing
  const build = await resolveBuild()
  return requestValidatedActivation(db, bioDb, input, build, now)
}

function commitActivationIntent(db: BetterSQLite3Database<typeof schema>, input: z.infer<typeof activationIntentSchema>, requestHash: string, now: number,
  verified?: ReturnType<typeof prepareVerifiedEvaluation> & { evaluationId: string }) {
  return db.transaction((tx) => {
    const existing = retryActivation(db, input.idempotencyKey, requestHash)
    if (existing) return existing
    const profiles = new ProfileStore(db)
    const storedBinding = tx.select().from(bindings).where(eq(bindings.side, input.side)).get()
    const binding = profiles.binding(input.side)
    let invalidLegacy: unknown
    if (!storedBinding) {
      const legacy = tx.select({ classifier: sideSettings.stageClassifier }).from(sideSettings).where(eq(sideSettings.side, input.side)).get()
      if (legacy?.classifier != null) {
        // Valid customizations must still migrate losslessly. Malformed legacy
        // data cannot become a revision; an explicit reset preserves it as audit
        // evidence and leaves the original legacy row untouched.
        if (input.action !== 'reset' || stageClassifierSchema.safeParse(legacy.classifier).success) {
          throw new ReferenceInputError('LEGACY_MIGRATION_REQUIRED', 'Preserve the existing stage profile before activation')
        }
        invalidLegacy = legacy.classifier
      }
    }
    if (binding.generation !== input.expectedGeneration) throw new ReferenceInputError('STALE_BINDING', 'Binding changed; inspect the side before applying this revision')
    if (input.action === 'reset' && input.revisionId !== null) throw new ReferenceInputError('INVALID_SELECTION', 'Reset must select system defaults')
    if (input.action === 'activate' && input.revisionId === null) throw new ReferenceInputError('INVALID_SELECTION', 'Activation must select an exact revision; use reset for defaults')
    if (input.action === 'rollback' && (binding.generation === 0 || input.revisionId !== binding.previousRevisionId)) throw new ReferenceInputError('INVALID_SELECTION', 'Rollback must select the previous binding')
    const selected = input.revisionId === null
      ? { resolved: defaultConfig, hash: configHash(defaultConfig) }
      : profiles.validateRevision(input.revisionId, input.side)
    if (selected.hash !== input.expectedResolvedHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Resolved configuration changed; inspect its exact hash before applying')
    const previous = profiles.effective(input.side)
    verified?.recheck()
    const generation = binding.generation + 1
    if (!storedBinding) {
      tx.insert(bindings).values({ side: input.side, generation, desiredRevisionId: input.revisionId,
        previousRevisionId: binding.desiredRevisionId, updatedAtMs: now }).run()
    }
    else {
      const changed = tx.update(bindings).set({ generation, desiredRevisionId: input.revisionId,
        previousRevisionId: binding.desiredRevisionId, updatedAtMs: now })
        .where(and(eq(bindings.side, input.side), eq(bindings.generation, input.expectedGeneration))).run()
      if (changed.changes !== 1) throw new ReferenceInputError('STALE_BINDING', 'Binding changed during activation')
    }
    const event = tx.insert(events).values({ id: randomUUID(), side: input.side, generation, action: input.action,
      previousRevisionId: binding.desiredRevisionId, nextRevisionId: input.revisionId, previousHash: previous.hash, nextHash: selected.hash,
      evaluationId: verified?.evaluationId ?? null,
      evidence: verified?.evidence ?? { status: 'manual_unvalidated', manifestHash, resolvedHash: selected.hash,
        ...(invalidLegacy === undefined ? {} : { recovery: 'invalid_legacy_reset', preservedLegacyClassifier: invalidLegacy }) }, requester: input.requester,
      state: 'pending_delivery', idempotencyKey: input.idempotencyKey, requestHash, createdAtMs: now, updatedAtMs: now }).returning().get()
    tx.insert(outbox).values({ id: randomUUID(), side: input.side, generation,
      payload: { schemaVersion: 1, side: input.side, generation, revisionId: input.revisionId, manifestHash,
        resolved: selected.resolved, resolvedHash: selected.hash, boundary: input.boundary },
      resolvedHash: selected.hash, state: 'pending', nextAttemptAtMs: now, createdAtMs: now }).run()
    return event
  }, { behavior: 'immediate' })
}
