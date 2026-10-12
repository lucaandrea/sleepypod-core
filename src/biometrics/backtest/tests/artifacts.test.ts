// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { ReportArtifactStore, REPORT_BUDGET_BYTES } from '../artifacts'
import { BacktestJobStore } from '../jobs'
import { DatasetStore } from '../datasets'
import { backtestFixture } from './fixtures/backtest'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'biometric-artifacts-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const id = '11111111-1111-4111-8111-111111111111'
it('atomically retains complete data, verifies bytes and rejects traversal and corrupt files', () => {
  const store = new ReportArtifactStore(directory)
  const report = { traces: Array.from({ length: 1100 }, () => 'x'.repeat(2048)) }
  const descriptor = store.write(id, 1, JSON.stringify(report), 0)
  expect(store.read(descriptor)).toEqual(report)
  expect(readdirSync(directory).filter(name => !name.startsWith('.publication.sqlite'))).toEqual([descriptor.name])
  expect(() => store.read({ ...descriptor, name: '../private.json' })).toThrow('descriptor')
  writeFileSync(join(directory, descriptor.name), 'corrupt')
  expect(() => store.read(descriptor)).toThrow('corrupt')
})
it('counts staged storage against quota and only collects old unreferenced owned files', () => {
  const store = new ReportArtifactStore(directory)
  expect(() => store.write(id, 1, '{}', REPORT_BUDGET_BYTES)).toThrow('budget')
  const committed = store.write(id, 1, '{"first":1}', 0)
  const orphan = store.write(id, 2, '{"second":2}', 0)
  const fresh = store.write(id, 3, '{"third":3}', 0)
  const old = new Date(Date.now() - 7200000)
  for (const name of [committed.name, orphan.name]) utimesSync(join(directory, name), old, old)
  writeFileSync(join(directory, 'unrelated.txt'), 'keep')
  expect(store.collect(new Set([committed.name]))).toBe(1)
  expect(readdirSync(directory).filter(name => !name.startsWith('.publication.sqlite')).sort()).toEqual([committed.name, fresh.name, 'unrelated.txt'].sort())
})
it('publishes a descriptor under the lease, resolves it after reopening, and retains an orphan after failed DB commit', () => {
  const databasePath = join(directory, 'biometrics.db')
  const raw = new Database(databasePath)
  try {
    const db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
    const now = Date.now()
    db.insert(schema.sleepRecords).values({ side: 'left', enteredBedAt: new Date(now - 3600000), leftBedAt: new Date(now), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
    const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'dataset' })
    const store = new BacktestJobStore(db)
    const fixture = backtestFixture()
    const experiment = store.createExperiment(dataset.id, fixture.job.protocol)
    const enqueue = (key: string) => store.enqueue({ experimentId: experiment.id, configs: fixture.job.configs, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: key, split: 'tuning' })
    const job = enqueue('first')
    const claimed = store.claim('fixture')
    if (!claimed) throw new Error('Missing lease')
    const report = { version: 'fixture', traces: Array.from({ length: 1100 }, () => 'x'.repeat(2048)) }
    store.complete({ id: job.id, owner: 'fixture', token: claimed.fencingToken }, report)
    const persisted = db.select().from(schema.biometricBacktestResults).get()
    expect(persisted?.report).toMatchObject({ kind: 'biometric-report-artifact-v1' })
    expect(Buffer.byteLength(JSON.stringify(persisted?.report))).toBeLessThan(512)
    const reopened = new Database(databasePath)
    try {
      expect(new BacktestJobStore(drizzle(reopened, { schema })).result(job.id)?.report).toEqual(report)
    }
    finally { reopened.close() }
    const second = enqueue('second')
    const secondLease = store.claim('fixture')
    if (!secondLease) throw new Error('Missing second lease')
    raw.exec('CREATE TRIGGER reject_result BEFORE INSERT ON biometric_backtest_results BEGIN SELECT RAISE(ABORT, \'full\'); END;')
    expect(() => store.complete({ id: second.id, owner: 'fixture', token: secondLease.fencingToken }, report)).toThrow('full')
    expect(store.get(second.id).state).toBe('running')
    expect(store.result(second.id)).toBeNull()
    const root = join(directory, 'biometric-report-artifacts')
    expect(readdirSync(root).filter(name => !name.startsWith('.publication.sqlite'))).toHaveLength(2)
    for (const name of readdirSync(root).filter(name => !name.startsWith('.publication.sqlite'))) {
      expect(JSON.parse(readFileSync(join(root, name), 'utf8'))).toEqual(report)
      utimesSync(join(root, name), new Date(0), new Date(0))
    }
    expect(store.collectOrphanedArtifacts()).toBe(1)
    expect(store.result(job.id)?.report).toEqual(report)
    const hash = persisted?.contentHash
    if (!hash) throw new Error('Missing report hash')
    raw.exec('CREATE TRIGGER reject_release BEFORE UPDATE ON biometric_backtest_results BEGIN SELECT RAISE(ABORT, \'full\'); END;')
    expect(() => store.releaseResult(job.id, hash)).toThrow('full')
    expect(store.result(job.id)?.report).toEqual(report)
    raw.exec('DROP TRIGGER reject_release')
    const released = store.releaseResult(job.id, hash)
    expect(released).toMatchObject({ available: false, report: null, contentHash: hash })
    expect(readdirSync(root).filter(name => !name.startsWith('.publication.sqlite'))).toEqual([])
    expect(store.releaseResult(job.id, hash)).toEqual(released)
    expect(store.result(job.id)).toEqual(released)
  }
  finally { raw.close() }
})

it('reuses an identical staged artifact near quota and serializes other publishers', () => {
  const store = new ReportArtifactStore(directory)
  const text = JSON.stringify({ value: 'data' })
  const descriptor = store.write(id, 1, text, 0)
  expect(store.write(id, 1, text, REPORT_BUDGET_BYTES - descriptor.byteLength)).toEqual(descriptor)
  const contender = new ReportArtifactStore(directory)
  store.withPublication(() => {
    expect(() => contender.write(id, 2, '{}', 0)).toThrow(/locked/)
  })
  expect(contender.write(id, 2, '{}', 0).byteLength).toBe(2)
})

it('releases the publication lock after a process dies without committing', async () => {
  const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3')
  const child = spawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setInterval(() => {}, 1000);
  `, sqliteModule, join(directory, '.publication.sqlite')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  try {
    await Promise.race([
      once(child, 'message'),
      exited.then(() => { throw new Error('Lock holder exited before readiness') }),
    ])
    const store = new ReportArtifactStore(directory)
    expect(() => store.write(id, 1, '{}', 0)).toThrow(/locked/)
    child.kill('SIGKILL')
    await exited
    const descriptor = store.write(id, 1, '{}', 0)
    expect(store.read(descriptor)).toEqual({})
  }
  finally {
    child.kill('SIGKILL')
    await exited
  }
})
