// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ShadowStore } from '../store'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const hash = 'a'.repeat(64), start = 1700000000000
const plan = { schema: 'biometric-shadow-plan-v1', side: 'left', candidateConfigHash: hash, activeConfigHash: 'b'.repeat(64),
  qualificationHash: 'c'.repeat(64), engineBuildHash: 'd'.repeat(64), startMs: start, endMs: start + 60000,
  maximumPoints: 3, maximumBytes: 10000, metrics: ['heart_rate'] }
function setup(policy = { maximumRuns: 10, maximumPoints: 10, maximumBytes: 100000 }) {
  const db = new Database(':memory:')
  databases.push(db)
  migrate(drizzle(db), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
  let now = start
  return { db, store: new ShadowStore(db, policy, () => now), advance: (ms: number) => {
    now += ms
  } }
}
function sample(sequence = 0) {
  return { sequence, side: 'left', timestampMs: start + sequence, inputHash: hash, candidateConfigHash: hash, activeConfigHash: plan.activeConfigHash,
    readings: [{ metric: 'heart_rate', candidate: { value: null, quality: 0 }, active: { value: 60, quality: 1 } }] }
}
describe('separate prospective shadow storage', () => {
  it('uses the generated additive migration and never writes canonical observations', () => {
    const { db, store } = setup()
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER deny_vitals_${operation} BEFORE ${operation} ON vitals BEGIN SELECT RAISE(ABORT, 'canonical write forbidden'); END`)
    const before = db.prepare('SELECT * FROM vitals').all()
    const run = store.create(plan, 'create')
    const lease = store.claim(run.id, 10000, (admitted) => {
      expect(admitted.qualificationHash).toBe(plan.qualificationHash)
    })
    expect(store.append(lease, sample())).toEqual({ state: 'recorded' })
    expect(store.append(lease, sample())).toEqual({ state: 'already_recorded' })
    expect(store.get(run.id)).toMatchObject({ point_count: 1, state: 'running' })
    expect(db.prepare('SELECT * FROM vitals').all()).toEqual(before)
    const payload = JSON.parse((db.prepare('SELECT payload FROM biometric_shadow_samples').get() as { payload: string }).payload)
    expect(payload).toMatchObject({ attemptId: lease.attemptId, readings: [{ candidate: { value: null }, active: { value: 60 } }] })
  })
  it('rejects retroactive windows and changed idempotency requests, while exact retries survive time passing', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    advance(100)
    expect(store.create(plan, 'first').id).toBe(run.id)
    expect(() => store.create(plan, 'second')).toThrow('prospective')
    expect(() => store.create({ ...plan, side: 'right' }, 'first')).toThrow('idempotency')
  })
  it('requires admission and fences replaced workers without losing retained samples', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(() => store.claim(run.id, 1000, () => {
      throw new Error('Unqualified build')
    })).toThrow('Unqualified build')
    expect(store.get(run.id).state).toBe('pending')
    const old = store.claim(run.id, 1000, () => undefined)
    store.append(old, sample())
    advance(1000)
    expect(() => store.append(old, sample(1))).toThrow('Stale')
    const current = store.claim(run.id, 1000, () => undefined)
    expect(() => store.renew(old, 1000)).toThrow('Stale')
    expect(() => store.finish(old, 'completed', 'stale')).toThrow('Stale')
    expect(store.append(current, sample(1))).toEqual({ state: 'recorded' })
    expect(store.get(run.id).point_count).toBe(2)
  })
  it('limits concurrent workers per side but permits the other side', () => {
    const { store } = setup()
    const first = store.create(plan, 'first'), second = store.create(plan, 'second'), right = store.create({ ...plan, side: 'right' }, 'right')
    store.claim(first.id, 1000, () => undefined)
    expect(() => store.claim(second.id, 1000, () => undefined)).toThrow('Side already')
    expect(store.claim(right.id, 1000, () => undefined).runId).toBe(right.id)
  })
  it('rejects configuration changes, duplicate metrics, future points, reordered points and altered retries', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    for (const invalid of [{ ...sample(), side: 'right' }, { ...sample(), candidateConfigHash: 'f'.repeat(64) }, { ...sample(), activeConfigHash: 'f'.repeat(64) },
      { ...sample(), timestampMs: start - 1 }, { ...sample(), timestampMs: start + 1 }, { ...sample(), readings: [...sample().readings, ...sample().readings] }]) {
      expect(() => store.append(lease, invalid)).toThrow('frozen plan')
    }
    store.append(lease, sample())
    expect(() => store.append(lease, { ...sample(), inputHash: 'f'.repeat(64) })).toThrow('idempotency')
    advance(100)
    expect(() => store.append(lease, sample(2))).toThrow('Out-of-order')
    expect(() => store.append(lease, { ...sample(1), timestampMs: start })).toThrow('Out-of-order')
  })
  it('atomically stops at per-run and global quotas and keeps stored evidence', () => {
    const { store, advance } = setup({ maximumRuns: 2, maximumPoints: 3, maximumBytes: 100000 })
    const first = store.create({ ...plan, maximumPoints: 1 }, 'first'), second = store.create({ ...plan, side: 'right' }, 'second')
    expect(() => store.create(plan, 'third')).toThrow('run quota')
    const lease = store.claim(first.id, 10000, () => undefined)
    const other = store.claim(second.id, 10000, () => undefined)
    store.append(lease, sample())
    advance(1)
    expect(store.append(lease, sample(1))).toEqual({ state: 'quota_reached' })
    expect(store.get(first.id)).toMatchObject({ state: 'stopped', reason: 'storage_quota', point_count: 1 })
    store.append(other, { ...sample(), side: 'right' })
    store.append(other, { ...sample(1), side: 'right' })
    advance(1)
    expect(store.append(other, { ...sample(2), side: 'right' })).toEqual({ state: 'quota_reached' })
    expect(store.get(second.id).point_count).toBe(2)
  })
  it('can cancel after deadline and cannot accept asynchronous admission', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(() => store.claim(run.id, 1000, async () => undefined)).toThrow('synchronously')
    expect(store.get(run.id).state).toBe('pending')
    const lease = store.claim(run.id, 1000, () => undefined)
    store.append(lease, sample())
    advance(60000)
    expect(() => store.renew(lease, 1000)).toThrow('Stale')
    expect(store.stop(run.id, 'window_elapsed')).toMatchObject({ state: 'stopped', reason: 'window_elapsed', point_count: 1 })
    expect(store.stop(run.id, 'retry')).toMatchObject({ reason: 'window_elapsed' })
    expect(() => store.claim(run.id, 1000, () => undefined)).toThrow('unavailable')
  })
  it('enforces byte quotas and terminal states', () => {
    const { store } = setup()
    const lease = store.claim(store.create({ ...plan, maximumBytes: 1 }, 'first').id, 1000, () => undefined)
    expect(store.append(lease, sample()).state).toBe('quota_reached')
    expect(() => store.append(lease, sample())).toThrow('Stale')
    const next = store.claim(store.create(plan, 'second').id, 1000, () => undefined)
    store.finish(next, 'failed', 'processor_failure')
    expect(store.get(next.runId)).toMatchObject({ state: 'failed', reason: 'processor_failure' })
    expect(() => store.renew(next, 1000)).toThrow('Stale')
  })
})
