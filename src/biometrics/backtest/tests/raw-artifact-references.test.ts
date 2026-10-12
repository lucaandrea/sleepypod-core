// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  for (const id of ['dataset-a', 'dataset-b']) db.insert(schema.biometricDatasets).values({ id, side: 'left', subjectId: 'fixture',
    idempotencyKey: id, requestHash: id, contentHash: id, manifest: {}, snapshot: {}, byteLength: 4, createdAtMs: 1000 }).run()
  for (const contentHash of ['hash-a', 'hash-b']) db.insert(schema.biometricRawArtifacts).values({ contentHash,
    name: `${contentHash}.RAW.gz`, compressedBytes: 100, expandedBytes: 200, createdAtMs: 1000 }).run()
})
afterEach(() => sqlite.close())

it('shares retained bytes across datasets while preserving unique immutable positions', () => {
  const link = { id: 'link-a', datasetId: 'dataset-a', artifactHash: 'hash-a', position: 0 }
  db.insert(schema.biometricDatasetRawArtifacts).values(link).run()
  db.insert(schema.biometricDatasetRawArtifacts).values({ ...link, id: 'link-b', datasetId: 'dataset-b' }).run()
  expect(() => db.insert(schema.biometricDatasetRawArtifacts).values({ ...link, id: 'duplicate', position: 1 }).run()).toThrow('UNIQUE')
  expect(() => db.insert(schema.biometricDatasetRawArtifacts).values({ ...link, id: 'reordered', artifactHash: 'hash-b' }).run()).toThrow('UNIQUE')
  // Releasing one association leaves another live reference and retains the
  // original position/identity for audit even after all references are released.
  sqlite.prepare('UPDATE biometric_dataset_raw_artifacts SET released_at_ms = 2000 WHERE id = ?').run('link-a')
  expect(sqlite.prepare('SELECT dataset_id FROM biometric_dataset_raw_artifacts WHERE artifact_hash = ? AND released_at_ms IS NULL').all('hash-a'))
    .toEqual([{ dataset_id: 'dataset-b' }])
  expect(() => db.delete(schema.biometricRawArtifacts).run()).toThrow('FOREIGN KEY')
  expect(() => db.delete(schema.biometricDatasets).run()).toThrow('FOREIGN KEY')
})

it('rejects dangling artifact references and duplicate storage names', () => {
  expect(() => db.insert(schema.biometricDatasetRawArtifacts).values({ id: 'missing-dataset', datasetId: 'missing', artifactHash: 'hash-a', position: 0 }).run()).toThrow('FOREIGN KEY')
  expect(() => db.insert(schema.biometricDatasetRawArtifacts).values({ id: 'missing-artifact', datasetId: 'dataset-a', artifactHash: 'missing', position: 0 }).run()).toThrow('FOREIGN KEY')
  expect(() => db.insert(schema.biometricRawArtifacts).values({ contentHash: 'another-hash', name: 'hash-a.RAW.gz',
    compressedBytes: 100, expandedBytes: 200, createdAtMs: 1000 }).run()).toThrow('UNIQUE')
})

it('releases only its own references and makes shared bytes collectible after the final release', async () => {
  const { DatasetStore } = await import('../datasets')
  let now = 2000
  const store = new DatasetStore(db, () => now)
  for (const datasetId of ['dataset-a', 'dataset-b']) db.insert(schema.biometricDatasetRawArtifacts).values({
    id: datasetId, datasetId, artifactHash: 'hash-a', position: 0,
  }).run()
  expect(store.release('dataset-a').releasedAtMs).toBe(2000)
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_raw_artifacts WHERE content_hash = ?').get('hash-a')).toEqual({ released_at_ms: null })
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_dataset_raw_artifacts WHERE dataset_id = ?').get('dataset-b')).toEqual({ released_at_ms: null })
  now = 3000
  store.release('dataset-b')
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_raw_artifacts WHERE content_hash = ?').get('hash-a')).toEqual({ released_at_ms: 3000 })
  // Unrelated unreferenced artifacts are not touched by a dataset release.
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_raw_artifacts WHERE content_hash = ?').get('hash-b')).toEqual({ released_at_ms: null })
  now = 4000
  expect(store.release('dataset-a').releasedAtMs).toBe(2000)
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_dataset_raw_artifacts WHERE dataset_id = ?').get('dataset-a')).toEqual({ released_at_ms: 2000 })
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_raw_artifacts WHERE content_hash = ?').get('hash-a')).toEqual({ released_at_ms: 3000 })
})

it.each(['queued', 'running', 'cancel_requested', 'interrupted'] as const)('preserves all retained inputs while a job is %s', async (state) => {
  const { DatasetStore } = await import('../datasets')
  db.insert(schema.biometricDatasetRawArtifacts).values({ id: 'link', datasetId: 'dataset-a', artifactHash: 'hash-a', position: 0 }).run()
  db.insert(schema.biometricExperiments).values({ id: 'experiment', datasetId: 'dataset-a', side: 'left', protocol: {}, protocolHash: 'fixture', createdAtMs: 1000 }).run()
  db.insert(schema.biometricBacktestJobs).values({ id: 'job', experimentId: 'experiment', idempotencyKey: 'job', requestHash: 'fixture',
    input: {}, state, progress: {}, createdAtMs: 1000, updatedAtMs: 1000 }).run()
  expect(() => new DatasetStore(db).release('dataset-a')).toThrow('Cancel or finish')
  for (const table of ['biometric_datasets', 'biometric_raw_artifacts', 'biometric_dataset_raw_artifacts']) {
    expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE released_at_ms IS NOT NULL`).get()).toEqual({ n: 0 })
  }
})

it('rolls back reference release if persisting the dataset tombstone fails', async () => {
  const { DatasetStore } = await import('../datasets')
  db.insert(schema.biometricDatasetRawArtifacts).values({ id: 'link', datasetId: 'dataset-a', artifactHash: 'hash-a', position: 0 }).run()
  sqlite.exec('CREATE TRIGGER fail_release BEFORE UPDATE ON biometric_datasets BEGIN SELECT RAISE(ABORT, \'injected failure\'); END')
  expect(() => new DatasetStore(db).release('dataset-a')).toThrow('injected failure')
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_dataset_raw_artifacts').get()).toEqual({ released_at_ms: null })
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_raw_artifacts WHERE content_hash = ?').get('hash-a')).toEqual({ released_at_ms: null })
})

it.each(['cancelled', 'succeeded', 'failed'] as const)('allows release after a job becomes %s', async (state) => {
  const { DatasetStore } = await import('../datasets')
  db.insert(schema.biometricDatasetRawArtifacts).values({ id: 'link', datasetId: 'dataset-a', artifactHash: 'hash-a', position: 0 }).run()
  db.insert(schema.biometricExperiments).values({ id: 'experiment', datasetId: 'dataset-a', side: 'left', protocol: {}, protocolHash: 'fixture', createdAtMs: 1000 }).run()
  db.insert(schema.biometricBacktestJobs).values({ id: 'job', experimentId: 'experiment', idempotencyKey: 'job', requestHash: 'fixture',
    input: {}, state, progress: {}, createdAtMs: 1000, updatedAtMs: 1000 }).run()
  expect(new DatasetStore(db, () => 2000).release('dataset-a').releasedAtMs).toBe(2000)
  expect(sqlite.prepare('SELECT released_at_ms FROM biometric_dataset_raw_artifacts').get()).toEqual({ released_at_ms: 2000 })
  expect(sqlite.prepare('SELECT state FROM biometric_backtest_jobs').get()).toEqual({ state })
})
