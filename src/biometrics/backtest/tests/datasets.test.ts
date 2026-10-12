// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { previewReferenceImport } from '../../references/normalize'
import { ReferenceStore } from '../../references/store'
import { DatasetStore } from '../datasets'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let datasets: DatasetStore
let references: ReferenceStore
const startMs = 1791673200000
const upload = { side: 'left' as const, subjectId: 'sleeper-A', source: 'fixture', rows: [
  { recordKey: 'hr', metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: startMs },
] }
const request = { side: 'left' as const, subjectId: 'sleeper-A', sessionIds: [1], referenceImportIds: [] as string[], timezone: 'America/Los_Angeles', idempotencyKey: 'dataset-1' }
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  datasets = new DatasetStore(db)
  references = new ReferenceStore(db)
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(startMs), leftBedAt: new Date(startMs + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(startMs), heartRate: 65 }).run()
})
afterEach(() => sqlite.close())

describe('retained processed datasets', () => {
  it('keeps exact input bytes after reference correction/deletion and observation retention', () => {
    const first = references.commit({ import: upload, previewHash: previewReferenceImport(upload).summary.contentHash })
    const dataset = datasets.create({ ...request, referenceImportIds: [first.id] })
    const before = datasets.read(dataset.id)
    const correction = { ...upload, rows: [{ ...upload.rows[0], value: 90 }] }
    references.commit({ import: correction, previewHash: previewReferenceImport(correction).summary.contentHash, supersedesImportId: first.id })
    references.delete(first.id)
    db.delete(schema.vitals).run()
    db.delete(schema.sleepRecords).run()
    const after = datasets.read(dataset.id)
    expect(after).toEqual(before)
    expect(after.snapshot.sessions[0].vitals[0].heartRate).toBe(65)
    expect(after.snapshot.references[0].measurements[0].value).toBe(60)
    expect(after.manifest).toMatchObject({ capabilities: { signalReplay: false, stageReplay: true }, splitProtocol: { evidence: 'descriptive_only' } })
    expect(datasets.create({ ...request, referenceImportIds: [first.id] }).id).toBe(dataset.id)
  })
  it('rejects cross-side sessions, sleeper mismatches, duplicate revisions and changed idempotency requests', () => {
    expect(() => datasets.create({ ...request, side: 'right' })).toThrow('missing or belongs')
    const first = references.commit({ import: upload, previewHash: previewReferenceImport(upload).summary.contentHash })
    expect(() => datasets.create({ ...request, subjectId: 'B', referenceImportIds: [first.id] })).toThrow('match')
    const correction = { ...upload, rows: [{ ...upload.rows[0], value: 70 }] }
    const second = references.commit({ import: correction, previewHash: previewReferenceImport(correction).summary.contentHash, supersedesImportId: first.id })
    expect(() => datasets.create({ ...request, referenceImportIds: [first.id, second.id] })).toThrow('one revision')
    datasets.create(request)
    expect(() => datasets.create({ ...request, timezone: 'UTC' })).toThrow('different selection')
  })
  it('detects corrupted retained bytes and enforces aggregate storage quota atomically', () => {
    const dataset = datasets.create(request)
    sqlite.prepare('UPDATE biometric_datasets SET snapshot = json_set(snapshot, ?, ?) WHERE id = ?')
      .run('$.sessions[0].vitals[0].heartRate', 99, dataset.id)
    expect(() => datasets.read(dataset.id)).toThrow('integrity')
    sqlite.prepare('UPDATE biometric_datasets SET byte_length = ?').run(64 * 1024 * 1024)
    expect(() => datasets.create({ ...request, idempotencyKey: 'second' })).toThrow('storage budget')
    expect(datasets.list('left')).toHaveLength(1)
    expect(datasets.list('right')).toEqual([])
  })
  it('retains and verifies realistic multi-night rows beyond the configuration hash node budget', () => {
    db.delete(schema.vitals).run()
    db.delete(schema.sleepRecords).run()
    const insert = sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)')
    sqlite.transaction(() => {
      for (let night = 1; night <= 3; night++) {
        const entered = startMs + night * 86400000
        db.insert(schema.sleepRecords).values({ id: night, side: 'left', enteredBedAt: new Date(entered), leftBedAt: new Date(entered + 43200000), sleepDurationSeconds: 43200, timesExitedBed: 0 }).run()
        for (let minute = 0; minute < 720; minute++) insert.run('left', entered / 1000 + minute * 60, 60 + (minute % 10) / 10)
      }
    })()
    const dataset = datasets.create({ ...request, sessionIds: [1, 2, 3] })
    expect(datasets.read(dataset.id).snapshot.sessions.reduce((total, session) => total + session.vitals.length, 0)).toBe(2160)
    expect(datasets.descriptor(dataset.id).contentHash).toBe(dataset.contentHash)
  })

  it('records exact processing bundles when available and keeps missing provenance explicit', () => {
    db.insert(schema.biometricProcessingRuns).values({ id: 'run-1', side: 'left', kind: 'live', bundle: { version: 'fixture' },
      configHash: 'fixture-hash', inputIdentity: { origin: 'fixture' }, startedAtMs: startMs }).run()
    sqlite.prepare('UPDATE vitals SET processing_run_id = ?').run('run-1')
    const frozen = datasets.read(datasets.create(request).id)
    expect(frozen.snapshot.processingRuns[0]).toMatchObject({ id: 'run-1', calibrationHash: null, bundle: { version: 'fixture' } })
    expect(frozen.snapshot.sessions[0].vitals[0].processingRunId).toBe('run-1')
    expect(frozen.manifest).toMatchObject({ coverage: [{ vitals: { count: 1, gapDurationMs: 3540000 } }] })
  })
})
