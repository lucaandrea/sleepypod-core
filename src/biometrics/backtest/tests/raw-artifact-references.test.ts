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
