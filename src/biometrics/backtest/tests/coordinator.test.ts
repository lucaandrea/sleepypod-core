// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCoordinatorTask } from '../coordinator'
import { BacktestJobStore } from '../jobs'
import { DatasetStore } from '../datasets'
import { workerBuildHash } from '../child'
import { backtestFixture } from './fixtures/backtest'
import * as schema from '@/src/db/biometrics-schema'
let directory: string
let databasePath: string
let coordinatorPath: string
let workerPath: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'biometric-coordinator-test-'))
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
  databasePath = join(directory, 'synthetic.db')
  coordinatorPath = join(directory, 'coordinator.cjs')
  workerPath = join(directory, 'worker.cjs')
  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  const start = Date.UTC(2026, 0, 1)
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start), heartRate: 60 }).run()
  sqlite.close()
})
afterAll(async () => rm(directory, { recursive: true, force: true }))
const options = () => ({ databasePath, coordinatorPath, workerPath, modulePath: resolve('node_modules') })
const id = '11111111-1111-4111-8111-111111111111'
it('creates retained inputs off-process and preserves idempotent retries and source observations', async () => {
  const input = { side: 'left' as const, subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'coordinator-test' }
  const first = await runCoordinatorTask(options(), { type: 'createDataset', input })
  const retry = await runCoordinatorTask(options(), { type: 'createDataset', input })
  expect(retry).toEqual(first)
  expect(first.available).toBe(true)
  const db = new Database(databasePath, { readonly: true })
  expect(db.prepare('SELECT count(*) n FROM vitals').get()).toEqual({ n: 1 })
  expect(db.prepare('SELECT count(*) n FROM biometric_datasets').get()).toEqual({ n: 1 })
  db.close()
})
it('preserves known error codes without leaking database diagnostics', async () => {
  await expect(runCoordinatorTask(options(), { type: 'readTrace', input: { id, configuration: 'default', expectedContentHash: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(runCoordinatorTask({ ...options(), databasePath: join(directory, 'missing.db') }, { type: 'readResult', input: { id } })).rejects.toMatchObject({ code: 'COORDINATOR_FAILED', message: 'Biometrics coordinator failed' })
})
it('requires fresh parent admission and supports a successful idle execution', async () => {
  let checks = 0
  expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'test' })).toEqual({ state: 'deferred' })
  expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'test' }, { admit: async () => {
    checks++
    return true
  } })).toEqual({ state: 'idle' })
  expect(checks).toBe(1)
})
it('keeps the calling event loop responsive during synchronous coordinator work', async () => {
  const busy = join(directory, 'busy.cjs')
  await writeFile(busy, 'process.on(\'message\',()=>{const end=Date.now()+500;while(Date.now()<end){};process.send({type:\'result\',result:null},()=>process.disconnect())})')
  let ticks = 0
  const timer = setInterval(() => ticks++, 25)
  try {
    expect(await runCoordinatorTask({ ...options(), coordinatorPath: busy }, { type: 'collectArtifacts' })).toBeNull()
    expect(ticks).toBeGreaterThan(4)
  }
  finally { clearInterval(timer) }
})
it('bounds a stalled coordinator and permits subsequent work', async () => {
  const stalled = join(directory, 'stalled.cjs')
  await writeFile(stalled, 'process.on("message",()=>{});setInterval(()=>{},1000)')
  await expect(runCoordinatorTask({ ...options(), coordinatorPath: stalled, timeoutMs: 100 }, { type: 'collectArtifacts' })).rejects.toThrow('time budget')
  expect(await runCoordinatorTask(options(), { type: 'collectArtifacts' })).toBeNull()
})
it.skipIf(process.platform === 'win32')('kills evaluator descendants when a coordinator crashes', async () => {
  const script = join(directory, 'crash.cjs'), pidPath = join(directory, 'descendant.pid')
  await writeFile(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.exit(1)})`)
  await expect(runCoordinatorTask({ ...options(), coordinatorPath: script }, { type: 'collectArtifacts' })).rejects.toThrow('complete result')
  const pid = Number(await readFile(pidPath, 'utf8'))
  let alive = true
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux' && (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z') alive = false
    }
    catch { alive = false }
    if (alive) await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(alive).toBe(false)
})

it('runs a leased evaluation and preserves report identity across the process boundary', async () => {
  const sqlite = new Database(databasePath)
  const db = drizzle(sqlite, { schema })
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'execute-dataset' })
  const jobs = new BacktestJobStore(db)
  const fixture = backtestFixture().job
  const experiment = jobs.createExperiment(dataset.id, fixture.protocol)
  const job = jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: await workerBuildHash(workerPath), configs: fixture.configs, split: 'tuning', idempotencyKey: 'execute-job' })
  try {
    expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'integration' }, { admit: async () => true })).toEqual({ state: 'succeeded', jobId: job.id })
    const result = await runCoordinatorTask(options(), { type: 'readResult', input: { id: job.id } })
    expect(result?.contentHash).toBe(jobs.result(job.id)?.contentHash)
    expect(result?.available).toBe(true)
  }
  finally { sqlite.close() }
})

it('cooperatively interrupts a running lease before shutdown completes', async () => {
  const slow = join(directory, 'slow-evaluator.cjs')
  await writeFile(slow, 'process.stdin.resume();setInterval(()=>{},1000)')
  const sqlite = new Database(databasePath)
  const db = drizzle(sqlite, { schema })
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'cancel-dataset' })
  const jobs = new BacktestJobStore(db), fixture = backtestFixture().job
  const experiment = jobs.createExperiment(dataset.id, fixture.protocol)
  const job = jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: await workerBuildHash(slow), configs: fixture.configs, split: 'tuning', idempotencyKey: 'cancel-job' })
  const controller = new AbortController()
  const running = runCoordinatorTask({ ...options(), workerPath: slow }, { type: 'execute', owner: 'cancel-test' }, { signal: controller.signal, admit: async () => true })
  const rejected = expect(running).rejects.toThrow('cancelled')
  try {
    for (let i = 0; i < 100 && jobs.get(job.id).state !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(jobs.get(job.id).state).toBe('running')
    controller.abort()
    await rejected
    expect(jobs.get(job.id)).toMatchObject({ state: 'interrupted', error: 'Worker host stopped' })
    expect(jobs.result(job.id)).toBeNull()
  }
  finally {
    controller.abort()
    await running.catch(() => {})
    sqlite.close()
  }
})
