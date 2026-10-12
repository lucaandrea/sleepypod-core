// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
let sqlite: Database.Database
let store: BacktestJobStore
let datasets: DatasetStore
let now: number
let datasetId: string
let experimentId: string
const config = { label: 'default' as const, revisionId: null, resolved: defaultConfig, resolvedHash: configHash(defaultConfig), manifestHash }
const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'stage_replay' as const, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
const enqueue = (idempotencyKey = 'job-1', split: 'tuning' | 'validation' | 'holdout' = 'tuning') => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey, split, configs: [config] })
const lease = (job: NonNullable<ReturnType<BacktestJobStore['claim']>>) => ({ id: job.id, owner: job.leaseOwner as string, token: job.fencingToken })
beforeEach(() => {
  now = 1791673200000
  sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  for (let id = 1; id <= 3; id++) db.insert(schema.sleepRecords).values({ id, side: 'left', enteredBedAt: new Date(now + id * 86400000),
    leftBedAt: new Date(now + id * 86400000 + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  datasets = new DatasetStore(db, () => now)
  datasetId = datasets.create({ side: 'left', subjectId: 'A', sessionIds: [1, 2, 3], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'dataset' }).id
  store = new BacktestJobStore(db, () => now)
  experimentId = store.createExperiment(datasetId, protocol).id
})
afterEach(() => sqlite.close())

describe('durable backtest leases and results', () => {
  it('deduplicates requests, permits only one active worker, and atomically publishes the winning attempt', () => {
    const job = enqueue()
    expect(enqueue().id).toBe(job.id)
    expect(() => enqueue('job-1', 'validation')).toThrow('changed')
    const claimed = store.claim('worker-A')
    expect(claimed).toMatchObject({ id: job.id, attempt: 1, fencingToken: 1 })
    expect(store.claim('worker-B')).toBeNull()
    if (!claimed) throw new Error('Missing claim')
    const token = lease(claimed)
    store.heartbeat(token, { phase: 'evaluating', completedNights: 0, totalNights: 1 })
    store.complete(token, { status: 'insufficient_evidence' })
    expect(store.get(job.id).state).toBe('succeeded')
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_backtest_results').get()).toEqual({ n: 1 })
    expect(() => store.complete(token, {})).toThrow('no longer authoritative')
  })
  it('releases inline report bytes idempotently without erasing holdout exposure or job identity', () => {
    const job = enqueue('release-report', 'holdout')
    expect(() => store.releaseResult(job.id, '0'.repeat(64))).toThrow('Only completed')
    const claimed = store.claim('worker-A')
    if (!claimed) throw new Error('Missing claim')
    const published = store.complete(lease(claimed), { traces: ['retained until release'] })
    expect(() => store.releaseResult(job.id, '0'.repeat(64))).toThrow('hash changed')
    expect(store.result(job.id)?.available).toBe(true)
    const released = store.releaseResult(job.id, published.contentHash)
    expect(released).toMatchObject({ available: false, report: null, releasedAtMs: now,
      contentHash: published.contentHash, fencingToken: claimed.fencingToken, currentHoldoutUseCount: 1 })
    now += 1000
    expect(store.releaseResult(job.id, published.contentHash)).toEqual(released)
    expect(store.result(job.id)).toEqual(released)
    expect(enqueue('release-report', 'holdout').id).toBe(job.id)
    expect(store.get(job.id).state).toBe('succeeded')
    expect(sqlite.prepare('SELECT report FROM biometric_backtest_results').get()).toEqual({ report: '{}' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_holdout_accesses').get()).toEqual({ n: 1 })
  })
  it('fences expired workers and retries crashes only within the attempt limit', () => {
    const job = enqueue()
    const first = store.claim('worker-A', 1000)
    if (!first) throw new Error('Missing claim')
    now += 1000
    expect(() => store.complete(lease(first), {})).toThrow('no longer authoritative')
    const second = store.claim('worker-B', 1000)
    expect(second).toMatchObject({ attempt: 2, fencingToken: 2 })
    expect(() => store.heartbeat(lease(first), { phase: 'loading', completedNights: 0, totalNights: 1 })).toThrow('no longer authoritative')
    now += 1000
    expect(store.claim('worker-C', 1000)).toMatchObject({ attempt: 3 })
    now += 1000
    expect(store.claim('worker-D')).toBeNull()
    expect(store.get(job.id)).toMatchObject({ state: 'failed', error: 'Worker lease expired' })
  })
  it('cancels queued jobs immediately and rejects publication after running cancellation', () => {
    const queued = enqueue()
    expect(store.cancel(queued.id).state).toBe('cancelled')
    expect(store.claim('worker')).toBeNull()
    const running = enqueue('second')
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    expect(store.cancel(running.id).state).toBe('cancel_requested')
    expect(store.heartbeat(lease(claimed), { phase: 'loading', completedNights: 0, totalNights: 1 })).toEqual({ cancelRequested: true })
    expect(() => store.complete(lease(claimed), {})).toThrow('cannot publish')
    store.acknowledgeCancellation(lease(claimed))
    expect(store.get(running.id).state).toBe('cancelled')
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_backtest_results').get()).toEqual({ n: 0 })
  })
  it('recovers abandoned cancellations without rerunning and rolls back failed result inserts', () => {
    const job = enqueue()
    const claimed = store.claim('worker', 1000)
    if (!claimed) throw new Error('Missing claim')
    sqlite.exec('CREATE TRIGGER reject_result BEFORE INSERT ON biometric_backtest_results BEGIN SELECT RAISE(ABORT, \'fixture failure\'); END;')
    expect(() => store.complete(lease(claimed), {})).toThrow('fixture failure')
    expect(store.get(job.id).state).toBe('running')
    store.cancel(job.id)
    now += 1000
    expect(store.claim('replacement')).toBeNull()
    expect(store.get(job.id).state).toBe('cancelled')
  })
  it('records holdout reuse across experiments and keeps duplicate enqueue from consuming it again', () => {
    const first = enqueue('holdout', 'holdout')
    expect(first.input).toMatchObject({ holdoutUse: 1, evidence: 'descriptive_only' })
    enqueue('holdout', 'holdout')
    expect(store.holdoutUseCount(datasetId)).toBe(1)
    experimentId = store.createExperiment(datasetId, protocol).id
    expect(enqueue('holdout-again', 'holdout').input).toMatchObject({ holdoutUse: 2, evidence: 'reused_holdout_is_validation' })
    expect(store.holdoutUseCount(datasetId)).toBe(2)
    const clone = datasets.create({ side: 'left', subjectId: 'different-asserted-name', sessionIds: [1, 2, 3], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'clone' })
    experimentId = store.createExperiment(clone.id, protocol).id
    expect(enqueue('cloned-holdout', 'holdout').input).toMatchObject({ holdoutUse: 3, evidence: 'reused_holdout_is_validation' })
    expect(store.holdoutUseCount(datasetId)).toBe(3)
  })
  it('rejects forged engine hashes and invalid progress without changing the lease', () => {
    expect(() => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'bad', split: 'tuning', configs: [{ ...config, resolvedHash: '0'.repeat(64) }] })).toThrow('does not match')
    enqueue()
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    expect(() => store.heartbeat(lease(claimed), { phase: 'evaluating', completedNights: 2, totalNights: 1 })).toThrow('monotonic')
    expect(store.get(claimed.id).progress).toMatchObject({ completedNights: 0 })
    store.fail(lease(claimed), 'bounded failure')
    expect(store.get(claimed.id).state).toBe('failed')
  })
})

it('refuses signal experiments without immutable waveform inputs', () => {
  expect(() => store.createExperiment(datasetId, { ...protocol, mode: 'signal_replay' })).toThrow('retained waveform inputs')
})
