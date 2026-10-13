import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/schema'
import { stageClassifierSchema, type StageClassifier } from '@/src/lib/sleep-stage-rules'
import { defaultConfig, legacyStageOverrides, type Override } from '../algorithms/registry'
import { configHash } from '../algorithms/canonical'
import { ReferenceInputError } from '../references/time'
import { requestManualActivation } from './activation'
import { ProfileStore } from './store'

/** Compatibility writes retain other metric overrides and use the same atomic
 * intent/outbox protocol. The legacy column is a migration baseline, not a
 * second writable authority. Null clears only sleep-stage personalization. */
export function writeLegacyStageClassifier(db: BetterSQLite3Database<typeof schema>, side: 'left' | 'right', classifier: StageClassifier | null, now = Date.now()) {
  const parsed = classifier === null ? null : stageClassifierSchema.parse(classifier)
  return db.transaction((tx) => {
    const settings = tx.select({ side: schema.sideSettings.side, classifier: schema.sideSettings.stageClassifier }).from(schema.sideSettings).where(eq(schema.sideSettings.side, side)).get()
    if (!settings) throw new ReferenceInputError('NOT_FOUND', `Side settings for ${side} not found`)
    const profiles = new ProfileStore(db, () => now)
    // An invalid legacy value already resolves to defaults. An explicit new
    // save can replace it without trying to create an invalid pinned revision.
    if (settings.classifier === null || stageClassifierSchema.safeParse(settings.classifier).success) profiles.migrateLegacy(side)
    const binding = profiles.binding(side)
    const current = binding.desiredRevisionId ? profiles.validateRevision(binding.desiredRevisionId, side) : null
    const overrides: Override[] = current
      ? (current.revision.overrides as Override[]).filter(override => !override.path.startsWith('sleep_stages.'))
      : []
    if (parsed) overrides.push(...legacyStageOverrides(parsed))
    const key = `legacy-stage-write:${randomUUID()}`
    const revision = overrides.length
      ? profiles.createRevision({ side, ...(current ? { parentRevisionId: current.revision.id } : {}),
          overrides, origin: 'manual', requester: 'legacy-stage-settings', idempotencyKey: key })
      : null
    const event = requestManualActivation(db, { side, action: revision ? 'activate' : 'reset', revisionId: revision?.id ?? null,
      expectedGeneration: binding.generation, expectedResolvedHash: revision?.resolvedHash ?? configHash(defaultConfig),
      boundary: 'immediate', requester: 'legacy-stage-settings', idempotencyKey: key, allowUnvalidated: true }, now)
    return { classifier: parsed ?? defaultConfig.sleep_stages, isDefault: parsed === null,
      activation: { generation: event.generation, revisionId: revision?.id ?? null, state: event.state } }
  }, { behavior: 'immediate' })
}
