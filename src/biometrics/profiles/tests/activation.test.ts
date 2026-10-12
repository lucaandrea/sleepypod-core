// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/schema'
import { ProfileStore } from '../store'
import { requestManualActivation } from '../activation'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig } from '../../algorithms/registry'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let profiles: ProfileStore
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  profiles = new ProfileStore(db)
})
afterEach(() => sqlite.close())
const candidate = () => profiles.createRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }], origin: 'manual', requester: 'fixture', idempotencyKey: 'candidate' })
const request = () => {
  const revision = candidate()
  return { side: 'left' as const, action: 'activate' as const, revisionId: revision.id, expectedGeneration: 0,
    expectedResolvedHash: revision.resolvedHash, boundary: 'next_session' as const, requester: 'fixture', idempotencyKey: 'activation', allowUnvalidated: true as const }
}
describe('atomic activation intent', () => {
  it('writes one binding, audit event and immutable outbox payload, without claiming adoption', () => {
    const input = request()
    const event = requestManualActivation(db, input)
    expect(event).toMatchObject({ generation: 1, state: 'pending_delivery', nextHash: input.expectedResolvedHash })
    expect(requestManualActivation(db, input)).toEqual(event)
    expect(profiles.binding('left')).toMatchObject({ generation: 1, desiredRevisionId: input.revisionId, previousRevisionId: null })
    expect(profiles.binding('right').generation).toBe(0)
    expect(db.select().from(schema.biometricConfigOutbox).all()).toHaveLength(1)
    expect(() => requestManualActivation(db, { ...input, idempotencyKey: 'stale' })).toThrow('Binding changed')
  })
  it('distinguishes rollback from reset and verifies exact target hashes', () => {
    const input = request()
    requestManualActivation(db, input)
    expect(() => requestManualActivation(db, { ...input, action: 'rollback', expectedGeneration: 1, idempotencyKey: 'wrong' })).toThrow('previous binding')
    const rollback = requestManualActivation(db, { ...input, action: 'rollback', revisionId: null, expectedGeneration: 1,
      expectedResolvedHash: configHash(defaultConfig), idempotencyKey: 'rollback' })
    expect(rollback).toMatchObject({ action: 'rollback', generation: 2, nextRevisionId: null })
    const reset = requestManualActivation(db, { ...input, action: 'reset', revisionId: null, expectedGeneration: 2,
      expectedResolvedHash: configHash(defaultConfig), idempotencyKey: 'reset' })
    expect(reset).toMatchObject({ action: 'reset', generation: 3 })
  })
  it('rolls back all intent writes when outbox insertion fails', () => {
    const input = request()
    sqlite.exec('CREATE TRIGGER reject_outbox BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'fixture failure\'); END;')
    expect(() => requestManualActivation(db, input)).toThrow('fixture failure')
    expect(profiles.binding('left').generation).toBe(0)
    expect(db.select().from(schema.biometricActivationEvents).all()).toEqual([])
  })
  it('requires legacy personalization to be preserved before a new binding can replace it', () => {
    db.insert(schema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: defaultConfig.sleep_stages }).run()
    expect(() => requestManualActivation(db, request())).toThrow('Preserve the existing stage profile')
    expect(profiles.binding('left').generation).toBe(0)
    expect(() => requestManualActivation(db, { ...request(), action: 'reset', revisionId: null, expectedResolvedHash: configHash(defaultConfig) })).toThrow('Preserve the existing stage profile')
    profiles.migrateLegacy('left')
    const input = request()
    expect(requestManualActivation(db, { ...input, expectedGeneration: 1 }).generation).toBe(2)
  })

  it('rejects incorrect hashes and changed idempotency payloads', () => {
    const input = request()
    expect(() => requestManualActivation(db, { ...input, expectedResolvedHash: '0'.repeat(64) })).toThrow('Resolved configuration changed')
    requestManualActivation(db, input)
    expect(() => requestManualActivation(db, { ...input, boundary: 'immediate' })).toThrow('idempotency key changed')
  })
})

it('allows explicit reset of malformed legacy rules while preserving the original as audit evidence', () => {
  const malformed = { engine: 'unknown-engine', ruleset: { cannotMigrate: true } }
  db.insert(schema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: malformed as unknown as typeof defaultConfig.sleep_stages }).run()
  expect(() => profiles.migrateLegacy('left')).toThrow()
  const input = { ...request(), action: 'reset' as const, revisionId: null, expectedResolvedHash: configHash(defaultConfig), idempotencyKey: 'recover-invalid-legacy' }
  expect(() => requestManualActivation(db, { ...input, expectedResolvedHash: '0'.repeat(64) })).toThrow('Resolved configuration changed')
  expect(profiles.binding('left').generation).toBe(0)
  const event = requestManualActivation(db, input)
  expect(event).toMatchObject({ action: 'reset', generation: 1, state: 'pending_delivery', nextRevisionId: null,
    evidence: { status: 'manual_unvalidated', recovery: 'invalid_legacy_reset', preservedLegacyClassifier: malformed } })
  expect(db.select().from(schema.sideSettings).get()?.stageClassifier).toEqual(malformed)
  expect(requestManualActivation(db, input).id).toBe(event.id)
  expect(profiles.migrateLegacy('left')).toMatchObject({ generation: 1, desiredRevisionId: null })
})

it('does not use malformed legacy recovery to bypass preservation or atomic publication', () => {
  db.insert(schema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: { broken: true } as unknown as typeof defaultConfig.sleep_stages }).run()
  expect(() => requestManualActivation(db, request())).toThrow('Preserve the existing stage profile')
  sqlite.exec('CREATE TRIGGER fail_reset_outbox BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'outbox failure\'); END;')
  expect(() => requestManualActivation(db, { ...request(), action: 'reset', revisionId: null, expectedResolvedHash: configHash(defaultConfig) })).toThrow('outbox failure')
  expect(profiles.binding('left').generation).toBe(0)
  expect(db.select().from(schema.biometricActivationEvents).all()).toEqual([])
  expect(db.select().from(schema.sideSettings).get()?.stageClassifier).toEqual({ broken: true })
})

it('resets an unavailable pinned engine without deleting or relabeling its previous revision', () => {
  const input = request()
  requestManualActivation(db, input)
  sqlite.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ? WHERE id = ?').run('old-engine', input.revisionId)
  expect(profiles.effective('left').warning).toContain('PROFILE_INCOMPATIBLE')
  const event = requestManualActivation(db, { ...input, action: 'reset', revisionId: null, expectedGeneration: 1, expectedResolvedHash: configHash(defaultConfig), idempotencyKey: 'reset-unavailable' })
  expect(event).toMatchObject({ generation: 2, nextRevisionId: null, previousRevisionId: input.revisionId })
  expect(profiles.binding('left').previousRevisionId).toBe(input.revisionId)
  expect(profiles.getRevision(input.revisionId).baseManifestHash).toBe('old-engine')
  expect(() => requestManualActivation(db, { ...input, action: 'rollback', expectedGeneration: 2, idempotencyKey: 'rollback-unavailable' })).toThrow('PROFILE_INCOMPATIBLE')
  expect(profiles.binding('left').generation).toBe(2)
})
