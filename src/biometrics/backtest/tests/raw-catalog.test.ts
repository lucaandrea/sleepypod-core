// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { RawSourceCatalog } from '../raw-catalog'

let sqlite: Database.Database
let catalog: RawSourceCatalog
let now: number
const digest = 'a'.repeat(64)
function inspection(source = 'capture.RAW.gz', sha256 = digest) {
  return { source_name: source, retained: false, artifact: { name: `${sha256}.RAW.gz`, sha256, compressed_bytes: 100, expanded_bytes: 200 },
    inventory: { version: 'retained-raw-inventory-v1', artifact_sha256: sha256,
      decoded_records: 2, piezo_records: 1, pump_records: 1, usable_dual_frames: 1, empty_channel_frames: 0,
      oversize_channel_frames: 0, invalid_timestamps: 0, timestamp_reversals: 0, duplicate_timestamps: 0,
      first_event_ms: 1000, last_event_ms: 2000,
      channels: { left1: { samples: 10, lost_markers: 1, truncated_tail_bytes: 0 }, right1: { samples: 10, lost_markers: 0, truncated_tail_bytes: 0 } },
      ordered_waveform_available: true, limitations: ['Fixture bounds do not establish continuous coverage.'] } }
}
beforeEach(() => {
  now = 3000
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  catalog = new RawSourceCatalog(db, () => now)
})
afterEach(() => sqlite.close())

describe('inspected RAW source catalog', () => {
  it('persists bounded evidence without claiming retained or current availability', () => {
    const input = inspection()
    const id = catalog.record(input)
    expect(catalog.read(id)).toEqual({ id, inspection: input, inspectedAtMs: 3000, unavailableAtMs: null, availability: 'requires_reverification' })
    now = 4000
    expect(catalog.record(input)).toBe(id)
    const reopened = new RawSourceCatalog(drizzle(sqlite, { schema }))
    expect(reopened.read(id).inspectedAtMs).toBe(4000)
    expect(sqlite.prepare('SELECT * FROM biometric_raw_artifacts').all()).toEqual([])
    expect(sqlite.prepare('SELECT * FROM biometric_datasets').all()).toEqual([])
  })

  it('preserves replaced identities and prevents a late failure from invalidating newer bytes', () => {
    const oldId = catalog.record(inspection())
    now = 5000
    const newId = catalog.record(inspection('capture.RAW.gz', 'b'.repeat(64)))
    expect(newId).not.toBe(oldId)
    expect(catalog.read(oldId)).toMatchObject({ unavailableAtMs: 5000, availability: 'unavailable', inspection: inspection() })
    now = 6000
    catalog.markUnavailable(oldId)
    expect(catalog.read(oldId).unavailableAtMs).toBe(5000)
    expect(catalog.page({ startMs: 1000, endMs: 2001 }).items.map(row => row.id)).toEqual([newId])
    catalog.markUnavailable(newId)
    expect(catalog.page({ startMs: 1000, endMs: 2001 }).items).toEqual([])
    now = 7000
    expect(catalog.record(inspection())).toBe(oldId)
    expect(catalog.read(oldId)).toMatchObject({ unavailableAtMs: null, inspectedAtMs: 7000 })
  })

  it('rejects conflicting evidence atomically and validates cross-field identities', () => {
    const id = catalog.record(inspection())
    const conflict = inspection()
    conflict.artifact.expanded_bytes++
    expect(() => catalog.record(conflict)).toThrow('different inspection evidence')
    expect(catalog.read(id).inspection).toEqual(inspection())
    const changed = inspection()
    changed.inventory.artifact_sha256 = 'b'.repeat(64)
    expect(() => catalog.record(changed)).toThrow('inspected bytes')
    expect(() => catalog.record({ ...inspection(), retained: true })).toThrow()
    expect(() => catalog.record(inspection('../escape.RAW.gz'))).toThrow()
    expect(() => catalog.record({ ...inspection(), extra: true })).toThrow()
    expect(() => catalog.read('0'.repeat(64))).toThrow('not found')
  })

  it('rejects inconsistent counts, event bounds, descriptors and capabilities', () => {
    const changes = [
      { first_event_ms: null }, { first_event_ms: 3000 }, { decoded_records: 1 },
      { empty_channel_frames: 1 }, { ordered_waveform_available: false }, { invalid_timestamps: 1 },
      { timestamp_reversals: 1 }, { oversize_channel_frames: 1 },
      { channels: { ...inspection().inventory.channels, left1: { samples: 1, lost_markers: 2, truncated_tail_bytes: 0 } } },
    ]
    for (const change of changes) expect(() => catalog.record({ ...inspection(), inventory: { ...inspection().inventory, ...change } })).toThrow()
    expect(() => catalog.record({ ...inspection(), artifact: { ...inspection().artifact, name: 'wrong.RAW.gz' } })).toThrow('content hash')
    expect(() => catalog.record({ ...inspection(), artifact: { ...inspection().artifact, expanded_bytes: Number.MAX_SAFE_INTEGER + 1 } })).toThrow()
  })

  it('pages potential overlap with half-open request boundaries and no duplicate identities', () => {
    const ids = Array.from({ length: 52 }, (_, index) => catalog.record(inspection(`capture-${index}.RAW.gz`))).sort()
    const first = catalog.page({ startMs: 2000, endMs: 3000 })
    expect(first.items.map(row => row.id)).toEqual(ids.slice(0, 50))
    expect(first.nextCursor).toBe(ids[49])
    const second = catalog.page({ startMs: 2000, endMs: 3000, afterId: first.nextCursor ?? undefined })
    expect(second.items.map(row => row.id)).toEqual(ids.slice(50))
    expect(second.nextCursor).toBeNull()
    expect(catalog.page({ startMs: 0, endMs: 1000 }).items).toEqual([])
    expect(catalog.page({ startMs: 2001, endMs: 3000 }).items).toEqual([])
    expect(() => catalog.page({ startMs: 1000, endMs: 1000 })).toThrow('nonempty')
  })

  it('detects corrupted indexed metadata before returning an inspected descriptor', () => {
    const id = catalog.record(inspection())
    sqlite.prepare('UPDATE biometric_raw_sources SET first_event_ms = 999 WHERE id = ?').run(id)
    expect(() => catalog.read(id)).toThrow('integrity check')
  })
})
