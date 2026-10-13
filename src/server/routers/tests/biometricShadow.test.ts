// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ShadowStore } from '@/src/biometrics/shadow/store'
import { cancelShadowServiceAttempt } from '@/src/biometrics/shadow/service-host'
import { biometricShadowRouter } from '../biometricShadow'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/src/db', () => ({ get biometricsDb() {
  return { $client: holder.db }
} }))
vi.mock('@/src/biometrics/shadow/service-host', () => ({ cancelShadowServiceAttempt: vi.fn() }))
const now = 1700000000000, hash = 'a'.repeat(64)
const plan = { schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'sleeper', startMs: now, endMs: now + 60000,
  candidateConfigHash: hash, activeConfigHash: hash, engineBuildHash: hash, qualificationHash: hash,
  maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
  monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 2000, minimumCandidateCoverage: 0.8,
    maximumCoverageLoss: 0.1, minimumQuality: 0.8,
    alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }
const caller = biometricShadowRouter.createCaller({})
let db: Database.Database, store: ShadowStore
beforeEach(() => {
  db = new Database(':memory:')
  migrate(drizzle(db), { migrationsFolder: 'src/db/biometrics-migrations' })
  holder.db = db
  store = new ShadowStore(db, { maximumRuns: 10, maximumPoints: 100, maximumBytes: 100000 }, () => now)
  vi.mocked(cancelShadowServiceAttempt).mockResolvedValue(false)
})
afterEach(() => {
  db.close()
  vi.resetAllMocks()
})

it('lists bounded side-specific metadata and preserves legacy identity ambiguity', async () => {
  const first = store.create(plan, 'first'), second = store.create({ ...plan, candidateRevisionId: null }, 'second')
  store.create({ ...plan, side: 'right' }, 'right')
  const page = await caller.list({ side: 'left', maximumRuns: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.nextCursor).toBe(page.items[0].id)
  if (!page.nextCursor) throw new Error('Expected next page')
  const next = await caller.list({ side: 'left', maximumRuns: 1, afterId: page.nextCursor })
  expect(next.nextCursor).toBeNull()
  expect([...page.items, ...next.items].map(row => row.id).sort()).toEqual([first.id, second.id].sort())
  expect(await caller.get({ id: first.id })).toMatchObject({ candidateRevisionId: null, candidateIdentitySaved: false, state: 'pending' })
  expect(await caller.get({ id: second.id })).toMatchObject({ candidateRevisionId: null, candidateIdentitySaved: true })
  expect(Object.keys(page.items[0])).not.toContain('plan')
  await expect(caller.list({ side: 'left', maximumRuns: 51 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

it('revokes authority before waiting for local cancellation and supports retries without execution policy', async () => {
  const run = store.create(plan, 'run')
  const lease = store.claim(run.id, 10000, () => {})
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    vi.mocked(cancelShadowServiceAttempt).mockImplementationOnce(async () => {
      expect(store.get(run.id).state).toBe('stopped')
      expect(() => store.renew(lease, 10000)).toThrow('Stale')
      resolve()
      await new Promise<void>((done) => {
        release = done
      })
      return true
    })
  })
  let settled = false
  const stopping = caller.stop({ id: run.id }).then((result) => {
    settled = true
    return result
  })
  await entered
  expect(settled).toBe(false)
  release()
  expect(await stopping).toMatchObject({ run: { state: 'stopped', reason: 'operator_requested' }, localAttemptSettled: true })
  const retry = await caller.stop({ id: run.id })
  expect(retry).toMatchObject({ run: { state: 'stopped', reason: 'operator_requested' }, localAttemptSettled: false })
})

it('preserves completed evidence on stop and returns safe unknown/corruption errors', async () => {
  const run = store.create(plan, 'run')
  store.finish(store.claim(run.id, 10000, () => {}), 'completed', 'complete')
  expect(await caller.stop({ id: run.id })).toMatchObject({ run: { state: 'completed', reason: 'complete' } })
  await expect(caller.get({ id: '11111111-1111-4111-8111-111111111111' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  db.prepare('UPDATE biometric_shadow_runs SET plan_hash = ? WHERE id = ?').run('corrupt', run.id)
  await expect(caller.get({ id: run.id })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Shadow operation failed' })
})

it('cannot create, claim or append with an inspection-only store', () => {
  const inspection = new ShadowStore(db), run = store.create(plan, 'run')
  expect(() => inspection.create(plan, 'new')).toThrow('policy required')
  expect(() => inspection.claim(run.id, 10000, () => {})).toThrow('policy required')
  const lease = store.claim(run.id, 10000, () => {})
  expect(() => inspection.append(lease, {})).toThrow('policy required')
  expect(inspection.get(run.id).state).toBe('running')
})

it('publishes concrete REST contracts for inspection and stop', () => {
  const document = generateOpenApiDocument(biometricShadowRouter, { title: 'Shadow', version: '1.0.0', baseUrl: 'http://localhost/api' })
  expect(document.paths?.['/biometric-tuning/shadow-runs']?.get).toBeDefined()
  expect(document.paths?.['/biometric-tuning/shadow-runs/{id}']?.get).toBeDefined()
  expect(document.paths?.['/biometric-tuning/shadow-runs/{id}/stop']?.post).toBeDefined()
})
