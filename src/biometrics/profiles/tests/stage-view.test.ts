// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { DEFAULT_STAGE_CLASSIFIER, MOVEMENT_ONLY_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'
import { ProfileStore } from '../store'
import { writeLegacyStageClassifier } from '../legacy-stage'
import { consumeStageView, resolveStageView } from '../stage-view'
import { deliverRuntimeOutbox, reconcileActivation } from '../runtime'
import { requestManualActivation } from '../activation'
let configRaw: Database.Database, bioRaw: Database.Database
let config: ReturnType<typeof drizzle<typeof configSchema>>, bio: ReturnType<typeof drizzle<typeof bioSchema>>
const movementOnly = { engine: 'rules' as const, ruleset: MOVEMENT_ONLY_STAGE_RULESET }
const now = 1791673200000
beforeEach(() => {
  configRaw = new Database(':memory:')
  bioRaw = new Database(':memory:')
  config = drizzle(configRaw, { schema: configSchema })
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(config, { migrationsFolder: 'src/db/migrations' })
  migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
  config.insert(configSchema.sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).run()
})
afterEach(() => {
  configRaw.close()
  bioRaw.close()
})
function acknowledge(generation: number, components = ['heart_rate', 'breathing_rate', 'hrv_index']) {
  deliverRuntimeOutbox(config, bio, now + 1)
  const row = bioRaw.prepare('SELECT resolved_hash FROM biometric_runtime_configs WHERE side = ? AND generation = ?').get('left', generation) as { resolved_hash: string }
  for (const component of components) bio.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation,
    appliedHash: row.resolved_hash, effectiveSampleTimeMs: now, state: 'applied', heartbeatAtMs: now }).run()
}
describe('stage view adoption and legacy compatibility', () => {
  it('waits for all numerical consumers, then acknowledges exactly the view delivered for classification', () => {
    const saved = writeLegacyStageClassifier(config, 'left', movementOnly, now)
    expect(saved.activation.generation).toBe(1)
    acknowledge(1, ['heart_rate', 'breathing_rate'])
    expect(consumeStageView(config, bio, 'left', now).classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
    expect(reconcileActivation(config, bio, 'left', now)?.state).toBe('pending_boundary')
    acknowledge(1, ['hrv_index'])
    const view = consumeStageView(config, bio, 'left', now)
    expect(view.classifier).toEqual(movementOnly)
    expect(view.provenance).toMatchObject({ source: 'runtime', generation: 1, interpretation: 'current_classifier_view' })
    expect(reconcileActivation(config, bio, 'left', now)?.state).toBe('applied')
    expect(resolveStageView(config, bio, 'right').classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
  })
  it('does not rescore from pending intent and preserves the last fully applied view', () => {
    writeLegacyStageClassifier(config, 'left', movementOnly, now)
    acknowledge(1)
    consumeStageView(config, bio, 'left', now)
    writeLegacyStageClassifier(config, 'left', null, now)
    acknowledge(2, ['heart_rate'])
    expect(resolveStageView(config, bio, 'left').classifier).toEqual(movementOnly)
    expect(resolveStageView(config, bio, 'left').provenance.generation).toBe(1)
    acknowledge(2, ['breathing_rate', 'hrv_index'])
    expect(consumeStageView(config, bio, 'left', now).classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
  })
  it('retains other metric overrides when legacy clients reset only stage rules', () => {
    const store = new ProfileStore(config)
    const revision = store.createRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }], origin: 'manual', requester: 'fixture', idempotencyKey: 'hr' })
    requestManualActivation(config, { side: 'left', action: 'activate', revisionId: revision.id, expectedGeneration: 0,
      expectedResolvedHash: revision.resolvedHash, boundary: 'immediate', requester: 'fixture', idempotencyKey: 'hr-active', allowUnvalidated: true }, now)
    writeLegacyStageClassifier(config, 'left', movementOnly, now)
    writeLegacyStageClassifier(config, 'left', null, now)
    expect(store.effective('left').resolved.heart_rate.trackingToleranceBpm).toBe(20)
    expect(store.effective('left').resolved.sleep_stages).toEqual(DEFAULT_STAGE_CLASSIFIER)
    expect(store.effective('left').binding.desiredRevisionId).not.toBeNull()
    expect(configRaw.prepare('SELECT stage_classifier FROM side_settings WHERE side = ?').get('left')).toEqual({ stage_classifier: null })
  })
  it('migrates existing customization before compatibility writes without losing its previous revision', () => {
    configRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run(JSON.stringify(movementOnly), 'left')
    const changed = writeLegacyStageClassifier(config, 'left', null, now)
    expect(changed.activation.generation).toBe(2)
    const store = new ProfileStore(config)
    const previousId = store.binding('left').previousRevisionId
    if (!previousId) throw new Error('Missing previous revision')
    const previous = store.getRevision(previousId)
    expect((previous.resolved as { sleep_stages: unknown }).sleep_stages).toEqual(movementOnly)
    expect(resolveStageView(config, bio, 'left').classifier).toEqual(movementOnly)
  })
  it('surfaces incompatible applied projections without acknowledging them as active', () => {
    writeLegacyStageClassifier(config, 'left', movementOnly, now)
    acknowledge(1)
    bioRaw.prepare('UPDATE biometric_runtime_configs SET payload = ?').run('{}')
    const view = consumeStageView(config, bio, 'left', now)
    expect(view.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
    expect(view.provenance.warning).toContain('incompatible')
    expect(bioRaw.prepare('SELECT * FROM biometric_runtime_receipts WHERE component=\'sleep_stages\'').all()).toEqual([])
  })
  it('rolls back the compatibility revision and binding when intent publication fails', () => {
    configRaw.exec('CREATE TRIGGER reject_outbox BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'full\'); END;')
    expect(() => writeLegacyStageClassifier(config, 'left', movementOnly, now)).toThrow('full')
    expect(config.select().from(configSchema.biometricProfileRevisions).all()).toEqual([])
    expect(config.select().from(configSchema.biometricProfileBindings).all()).toEqual([])
  })
})
