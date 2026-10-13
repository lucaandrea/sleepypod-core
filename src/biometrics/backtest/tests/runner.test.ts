// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
import { workerBuildHash } from '../child'
import { executeNextBacktest } from '../runner'
import { backtestFixture } from './fixtures/backtest'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let jobs: BacktestJobStore
let jobId: string
let directory: string
let evaluatorBuildHash: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'biometric-runner-test-'))
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
  evaluatorBuildHash = await workerBuildHash(join(directory, 'worker.cjs'))
})
afterAll(async () => rm(directory, { recursive: true, force: true }))
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  const fixture = backtestFixture()
  const session = fixture.dataset.snapshot.sessions[0]
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(session.startMs), leftBedAt: new Date(session.endMs), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  for (const row of session.vitals) db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(row.timestampMs), heartRate: row.heartRate, hrv: row.hrv, breathingRate: row.breathingRate }).run()
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'run' })
  jobs = new BacktestJobStore(db)
  const experiment = jobs.createExperiment(dataset.id, fixture.job.protocol)
  jobId = jobs.enqueue({ evaluatorBuildHash, experimentId: experiment.id, configs: fixture.job.configs,
    idempotencyKey: 'run', split: 'tuning' }).id
})
afterEach(() => sqlite.close())
const options = { owner: 'integration-test', get workerPath() {
  return join(directory, 'worker.cjs')
}, admit: async () => true }

describe('durable replay execution', () => {
  it('runs retained data through a child and publishes an integrity-checked result without changing canonical observations', async () => {
    const before = sqlite.prepare('SELECT * FROM vitals').all()
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'succeeded', jobId })
    expect(jobs.result(jobId)?.report).toMatchObject({ version: 'processed-backtest-report-v1', nights: [{ uniqueObservationCount: 10 }] })
    expect(jobs.result(jobId)?.report).toMatchObject({ jobOperations: { ingestion: { allChecksMeasured: false, samples: 0, maximumObservedAgeMs: null } } })
    expect(sqlite.prepare('SELECT * FROM vitals').all()).toEqual(before)
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'idle' })
  })
  it('retains supervisor observations in the committed report and marks legacy boolean admission unmeasured', async () => {
    let checks = 0
    expect(await executeNextBacktest(db, { ...options, admit: async () => {
      checks++
      return true
    },
    admissionReceipt: () => ({ allowed: true, sample: { qualificationId: 'test-policy', checkedAtMs: Date.now(), ingestionAgeMs: checks * 100 } }),
    })).toEqual({ state: 'succeeded', jobId })
    expect(jobs.result(jobId)?.report).toMatchObject({ jobOperations: { version: 'backtest-job-operations-v1',
      ingestion: { allChecksMeasured: true, checks: 2, samples: 2, maximumObservedAgeMs: 200, qualificationId: 'test-policy' } } })
  })
  it('refuses to execute a different worker bundle after enqueue', async () => {
    sqlite.prepare('UPDATE biometric_backtest_jobs SET input = json_set(input, \'$.evaluatorBuildHash\', ?)').run('0'.repeat(64))
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId).state).toBe('failed')
    expect(jobs.result(jobId)).toBeNull()
  })

  it('defers work before claim when resource admission is denied or shutdown arrives', async () => {
    expect(await executeNextBacktest(db, { ...options, admit: async () => false })).toEqual({ state: 'deferred' })
    expect(jobs.get(jobId).attempt).toBe(0)
    const controller = new AbortController()
    expect(await executeNextBacktest(db, { ...options, signal: controller.signal, admit: async () => {
      controller.abort()
      return true
    } })).toEqual({ state: 'deferred' })
    expect(jobs.get(jobId).attempt).toBe(0)
  })
  it('interrupts a running child when health declines and never publishes its result', async () => {
    const stalledPath = join(directory, 'stalled.cjs')
    await writeFile(stalledPath, 'process.stdin.resume(); setInterval(() => {}, 1000)')
    const hash = await workerBuildHash(stalledPath)
    sqlite.prepare('UPDATE biometric_backtest_jobs SET input = json_set(input, \'$.evaluatorBuildHash\', ?)').run(hash)
    let checks = 0
    const result = await executeNextBacktest(db, { ...options, workerPath: stalledPath, admit: async () => ++checks === 1 })
    expect(result).toEqual({ state: 'stopped', jobId })
    expect(checks).toBe(2)
    expect(jobs.get(jobId)).toMatchObject({ state: 'interrupted', error: 'Resource admission withdrawn' })
    expect(jobs.result(jobId)).toBeNull()
  }, 10000)

  it('withholds publication when the final resource check fails', async () => {
    let checks = 0
    expect(await executeNextBacktest(db, { ...options, admit: async () => {
      if (++checks === 1) return true
      throw new Error('Health collector unavailable')
    } })).toEqual({ state: 'stopped', jobId })
    expect(checks).toBe(2)
    expect(jobs.get(jobId)).toMatchObject({ state: 'interrupted', error: 'Resource admission withdrawn' })
    expect(jobs.result(jobId)).toBeNull()
  })
})
