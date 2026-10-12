// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@/src/db/schema'
import { DEFAULT_STAGE_CLASSIFIER } from '@/src/lib/sleep-stage-rules'
import { defaultConfig } from '../../algorithms/registry'
import { ProfileStore } from '../store'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let store: ProfileStore
const request = { side: 'left' as const, overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
  origin: 'manual' as const, requester: 'test', idempotencyKey: 'candidate-1' }

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  store = new ProfileStore(db, () => 1700000000000)
})
afterEach(() => sqlite.close())

describe('immutable profile repository', () => {
  it('creates an idempotent candidate without activating it', () => {
    const first = store.createRevision(request)
    expect(store.createRevision(request)).toEqual(first)
    expect(store.createRevision({ ...request, parentRevisionId: undefined })).toEqual(first)
    expect(first.revision).toBe(1)
    expect(store.effective('left')).toMatchObject({ isDefault: true, binding: { generation: 0 } })
    expect(store.validateRevision(first.id, 'left').resolved.heart_rate.trackingToleranceBpm).toBe(20)
    expect(() => store.createRevision({ ...request, overrides: [] })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(db.select().from(schema.biometricConfigOutbox).all()).toEqual([])
  })

  it('preserves the parent snapshot and serializes family revision numbers', () => {
    const first = store.createRevision(request)
    const second = store.createRevision({ ...request, parentRevisionId: first.id, overrides: [], idempotencyKey: 'candidate-2' })
    const third = store.createRevision({ ...request, parentRevisionId: first.id, overrides: [], idempotencyKey: 'candidate-3' })
    expect([second.revision, third.revision]).toEqual([2, 3])
    expect(second.familyId).toBe(first.familyId)
    expect(store.getRevision(first.id)).toEqual(first)
    expect(store.validateRevision(second.id, 'left').resolved).toEqual(defaultConfig)
    expect(store.listRevisions('left', undefined, first.familyId).items.map(r => r.id).sort()).toEqual([first.id, second.id, third.id].sort())
  })

  it('rejects cross-side inheritance, unknown parents and tampered snapshots', () => {
    const first = store.createRevision(request)
    expect(() => store.createRevision({ ...request, side: 'right', parentRevisionId: first.id, idempotencyKey: 'right' })).toThrow('other side')
    expect(() => store.validateRevision(first.id, 'right')).toThrow('other side')
    expect(() => store.createRevision({ ...request, parentRevisionId: '00000000-0000-4000-8000-000000000000', idempotencyKey: 'missing' })).toThrow('NOT_FOUND')
    db.update(schema.biometricProfileRevisions).set({ resolvedHash: 'bad' }).where(eq(schema.biometricProfileRevisions.id, first.id)).run()
    expect(() => store.validateRevision(first.id, 'left')).toThrow('integrity')
  })

  it('reports a visible default fallback for an unavailable pinned engine', () => {
    const first = store.createRevision(request)
    db.insert(schema.biometricProfileBindings).values({ side: 'left', desiredRevisionId: first.id, generation: 2, updatedAtMs: 1 }).run()
    db.update(schema.biometricProfileRevisions).set({ baseManifestHash: 'unavailable' }).run()
    expect(store.effective('left')).toMatchObject({ isDefault: true, warning: expect.stringContaining('PROFILE_INCOMPATIBLE'), resolved: defaultConfig })
    expect(store.binding('left').desiredRevisionId).toBe(first.id)
  })
})

describe('legacy stage migration', () => {
  it('preserves exact rules and commits binding, evidence and outbox atomically', () => {
    const classifier = structuredClone(DEFAULT_STAGE_CLASSIFIER)
    classifier.ruleset.rules.reverse()
    classifier.ruleset.smoothIsolatedEpochs = false
    db.insert(schema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: classifier }).run()
    const binding = store.migrateLegacy('left')
    if (!binding?.desiredRevisionId) throw new Error('Expected migrated binding')
    expect(store.migrateLegacy('left')).toEqual(binding)
    expect(store.validateRevision(binding.desiredRevisionId, 'left').resolved.sleep_stages).toEqual(classifier)
    expect(db.select().from(schema.biometricProfileRevisions).all()).toHaveLength(1)
    expect(db.select().from(schema.biometricActivationEvents).get()).toMatchObject({ generation: 1, evidence: { status: 'legacy_unvalidated' }, state: 'pending_delivery' })
    expect(db.select().from(schema.biometricConfigOutbox).get()).toMatchObject({ generation: 1, state: 'pending' })
    expect(db.select().from(schema.sideSettings).get()?.stageClassifier).toEqual(classifier)
    expect(store.effective('right').isDefault).toBe(true)
  })

  it('keeps null on system defaults and refuses to discard invalid legacy settings', () => {
    db.insert(schema.sideSettings).values({ side: 'right', name: 'Right' }).run()
    expect(store.migrateLegacy('right')).toBeNull()
    db.insert(schema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: { engine: 'unknown' } }).run()
    expect(() => store.migrateLegacy('left')).toThrow()
    expect(db.select().from(schema.biometricProfileBindings).all()).toEqual([])
    expect(db.select().from(schema.biometricProfileRevisions).all()).toEqual([])
  })

  it('rolls back the entire migration if outbox publication fails', () => {
    db.insert(schema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: DEFAULT_STAGE_CLASSIFIER }).run()
    sqlite.exec('CREATE TRIGGER fail_outbox BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'disk full\'); END')
    expect(() => store.migrateLegacy('left')).toThrow()
    expect(db.select().from(schema.biometricProfileBindings).all()).toEqual([])
    expect(db.select().from(schema.biometricActivationEvents).all()).toEqual([])
    expect(db.select().from(schema.biometricProfileRevisions).all()).toEqual([])
  })
})
