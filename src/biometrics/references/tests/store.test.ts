// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { previewReferenceImport } from '../normalize'
import { ReferenceStore } from '../store'
import type { ReferenceImportInput } from '../contracts'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let store: ReferenceStore
const T = Date.UTC(2026, 9, 10, 23)
const input = (value = 60): ReferenceImportInput => ({ side: 'left', subjectId: 'sleeper-A', source: 'test', rows: [
  { recordKey: 'one', metric: 'heart_rate', value, unit: 'bpm', timestampMs: T },
] })
function commit(value = 60, supersedesImportId?: string) {
  const data = input(value)
  return store.commit({ import: data, previewHash: previewReferenceImport(data).summary.contentHash, supersedesImportId })
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  store = new ReferenceStore(db, () => 1700000000000)
})
afterEach(() => sqlite.close())

describe('reference persistence', () => {
  it('previews without writes and commits identical content once', () => {
    const preview = previewReferenceImport(input())
    expect(db.select().from(schema.referenceImports).all()).toEqual([])
    const first = store.commit({ import: input(), previewHash: preview.summary.contentHash })
    expect(commit()).toMatchObject({ id: first.id, alreadyImported: true })
    expect(store.measurements(first.id).items[0]).toMatchObject({ value: 60, temporalKind: 'point' })
    expect(db.select().from(schema.vitals).all()).toEqual([])
    expect(db.select().from(schema.referenceImports).all()).toHaveLength(1)
  })

  it('requires exact preview and deliberate acceptance of rejected rows', () => {
    const preview = previewReferenceImport(input())
    expect(() => store.commit({ import: input(61), previewHash: preview.summary.contentHash })).toThrow('preview')
    const partial = { ...input(), rows: [...input().rows, { unknown: 'ignored?' }] }
    const hash = previewReferenceImport(partial).summary.contentHash
    expect(() => store.commit({ import: partial, previewHash: hash })).toThrow('partial import')
    expect(store.commit({ import: partial, previewHash: hash, acceptRejectedRows: true }).summary).toMatchObject({ accepted: 1, rejected: 1 })
  })

  it('stores corrections as revisions without changing older measurements and rejects stale parent edits', () => {
    const first = commit()
    const corrected = commit(61, first.id)
    expect(corrected).toMatchObject({ familyId: first.familyId, revision: 2, supersedesImportId: first.id })
    expect(store.measurements(first.id).items[0].value).toBe(60)
    expect(store.measurements(corrected.id).items[0].value).toBe(61)
    expect(commit(61, first.id)).toMatchObject({ id: corrected.id, alreadyImported: true })
    expect(() => commit(62, first.id)).toThrow('Another correction')
    const otherSide = { ...input(62), side: 'right' as const }
    expect(() => store.commit({ import: otherSide, previewHash: previewReferenceImport(otherSide).summary.contentHash, supersedesImportId: corrected.id })).toThrow('mapping')
  })

  it('can correct a reference back to an earlier value without returning the old revision', () => {
    const first = commit(60)
    const second = commit(61, first.id)
    const third = commit(60, second.id)
    expect(third).toMatchObject({ revision: 3, familyId: first.familyId, supersedesImportId: second.id, alreadyImported: false })
    expect(third.id).not.toBe(first.id)
    expect(commit(60, second.id)).toMatchObject({ id: third.id, alreadyImported: true })
    expect(store.measurements(first.id).items[0].value).toBe(60)
  })

  it('rolls back metadata when measurement publication fails', () => {
    sqlite.exec('CREATE TRIGGER fail_measurement BEFORE INSERT ON reference_measurements BEGIN SELECT RAISE(ABORT, \'disk full\'); END')
    expect(() => commit()).toThrow()
    expect(db.select().from(schema.referenceImports).all()).toEqual([])
    expect(db.select().from(schema.referenceMeasurements).all()).toEqual([])
  })

  it('paginates every retained row explicitly and makes deleted data unavailable', () => {
    const data = { ...input(), rows: Array.from({ length: 503 }, (_, i) => ({ recordKey: String(i), metric: 'heart_rate', unit: 'bpm', value: 60, timestampMs: T + i * 60000 })) }
    const result = store.commit({ import: data, previewHash: previewReferenceImport(data).summary.contentHash })
    const page = store.measurements(result.id)
    expect(page.items).toHaveLength(500)
    const remaining = store.measurements(result.id, page.nextCursor ?? 0)
    expect(remaining.items).toHaveLength(3)
    expect(remaining.nextCursor).toBeNull()
    const deleted = store.delete(result.id)
    expect(store.delete(result.id)).toEqual(deleted)
    expect(store.get(result.id).available).toBe(false)
    expect(() => store.measurements(result.id)).toThrow('deleted')
    expect(db.select().from(schema.referenceMeasurements).all()).toEqual([])
    expect(store.commit({ import: data, previewHash: previewReferenceImport(data).summary.contentHash }).id).not.toBe(result.id)
  })
})
