// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { DatasetStore } from '../datasets'
import { RawSourceCatalog } from '../raw-catalog'
import { createWaveformDatasetSchema, prepareSelectedWaveformDataset, recordedWaveformContexts } from '../waveform-selection'
import { datasetManifestSchema } from '../contracts'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let parent: ReturnType<DatasetStore['read']>
const start = 1700000000000
let sourceIds: string[]
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000),
    sleepDurationSeconds: 600, timesExitedBed: 1, presentIntervals: [[start / 1000, start / 1000 + 60]],
    notPresentIntervals: [[start / 1000 + 60, start / 1000 + 120]] }).run()
  const store = new DatasetStore(db)
  parent = store.read(store.create({ side: 'left', subjectId: 'test', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'parent' }).id)
  sourceIds = [0, 1].map((index) => {
    const sha256 = String(index + 1).repeat(64)
    return new RawSourceCatalog(db).record({ source_name: `${index}.RAW.gz`, retained: false,
      artifact: { name: `${sha256}.RAW.gz`, sha256, compressed_bytes: 100, expanded_bytes: 200 },
      inventory: { version: 'retained-raw-inventory-v1', artifact_sha256: sha256, decoded_records: 2, piezo_records: 1, pump_records: 1,
        usable_dual_frames: 1, empty_channel_frames: 0, oversize_channel_frames: 0, invalid_timestamps: 0, timestamp_reversals: 0,
        duplicate_timestamps: 0, first_event_ms: start - 300000 + index * 450000, last_event_ms: start + 149999 + index * 450000,
        channels: { left1: { samples: 10, lost_markers: 0, truncated_tail_bytes: 0 }, right1: { samples: 10, lost_markers: 0, truncated_tail_bytes: 0 } },
        ordered_waveform_available: true, limitations: [] } })
  })
})
afterEach(() => sqlite.close())
const request = () => ({ parentDatasetId: parent.id, expectedContentHash: parent.contentHash, idempotencyKey: 'waveform',
  cohorts: [{ cohortId: datasetManifestSchema.parse(parent.manifest).splitProtocol.assignments[0].cohortId, sourceIds: [...sourceIds].reverse() }] })

it('resolves ordered immutable source identities and recorded occupancy without reading current state', () => {
  sqlite.prepare('UPDATE sleep_records SET present_intervals = NULL, not_present_intervals = NULL').run()
  const result = prepareSelectedWaveformDataset(db, request(), 123)
  expect(result.selections.map(item => item.source_name)).toEqual(['0.RAW.gz', '1.RAW.gz'])
  if (result.prepared.snapshot.version !== 'waveform-dataset-v1') throw new Error('Wrong snapshot')
  expect(result.prepared.snapshot.waveformInputs[0].input).toMatchObject({ retained_start_ms: start - 300000,
    score_start_ms: start, score_end_ms: start + 600000, contexts: [
      { start_ms: start, end_ms: start + 60000, left_occupied: true, right_occupied: null, active_sides: null, pump_context_known: false },
      { start_ms: start + 60000, end_ms: start + 120000, left_occupied: false, right_occupied: null, active_sides: null, pump_context_known: false },
    ] })
  const retry = request()
  retry.cohorts[0].sourceIds.reverse()
  expect(prepareSelectedWaveformDataset(db, retry, 456).prepared.contentHash).toBe(result.prepared.contentHash)
  expect(sqlite.prepare('SELECT count(*) n FROM biometric_datasets').get()).toEqual({ n: 1 })
  expect(sqlite.prepare('SELECT count(*) n FROM biometric_raw_artifacts').get()).toEqual({ n: 0 })
})

it('rejects stale, duplicate, incomplete and forged selections', () => {
  expect(() => prepareSelectedWaveformDataset(db, { ...request(), expectedContentHash: '0'.repeat(64) })).toThrow('expected immutable')
  expect(() => prepareSelectedWaveformDataset(db, { ...request(), cohorts: [...request().cohorts, ...request().cohorts] })).toThrow('each whole-night')
  const duplicate = request()
  duplicate.cohorts[0].sourceIds = [sourceIds[0], sourceIds[0]]
  expect(() => prepareSelectedWaveformDataset(db, duplicate)).toThrow('each RAW source')
  const missing = request()
  missing.cohorts[0].cohortId = 'missing'
  expect(() => prepareSelectedWaveformDataset(db, missing)).toThrow('Missing whole-night')
  expect(() => createWaveformDatasetSchema.parse({ ...request(), archiveDirectory: '/tmp' })).toThrow()
  new RawSourceCatalog(db).markUnavailable(sourceIds[0])
  expect(() => prepareSelectedWaveformDataset(db, request())).toThrow('unavailable')
})

it('retains unknown context for gaps, malformed evidence and contradictory intervals', () => {
  const snapshot = structuredClone(parent.snapshot)
  snapshot.sessions[0].presentIntervals = [[start / 1000 - 10, start / 1000 + 60], ['bad', 10], [Infinity, 50], [10, 0]]
  snapshot.sessions[0].notPresentIntervals = [[start / 1000 + 30, start / 1000 + 90]]
  expect(recordedWaveformContexts(snapshot, start - 300000, start + 600000)).toEqual([
    { start_ms: start, end_ms: start + 30000, left_occupied: true, right_occupied: null, active_sides: null, pump_context_known: false },
    { start_ms: start + 60000, end_ms: start + 90000, left_occupied: false, right_occupied: null, active_sides: null, pump_context_known: false },
  ])
  snapshot.side = 'right'
  expect(recordedWaveformContexts(snapshot, start + 10000, start + 20000)).toEqual([
    { start_ms: start + 10000, end_ms: start + 20000, right_occupied: true, left_occupied: null, active_sides: null, pump_context_known: false },
  ])
  snapshot.sessions[0].presentIntervals = null
  snapshot.sessions[0].notPresentIntervals = { unrecognized: true }
  expect(recordedWaveformContexts(snapshot, start, start + 600000)).toEqual([])
})

it('merges consistent overlapping intervals, preserves fractional seconds and bounds recorded evidence', () => {
  const snapshot = structuredClone(parent.snapshot)
  snapshot.sessions[0].presentIntervals = [[start / 1000 + 0.125, start / 1000 + 40], [start / 1000 + 30, start / 1000 + 60]]
  snapshot.sessions[0].notPresentIntervals = null
  expect(recordedWaveformContexts(snapshot, start, start + 600000)).toEqual([
    { start_ms: start + 125, end_ms: start + 60000, left_occupied: true, right_occupied: null, active_sides: null, pump_context_known: false },
  ])
  snapshot.sessions[0].presentIntervals = Array(20001).fill([1, 2])
  expect(() => recordedWaveformContexts(snapshot, start, start + 600000)).toThrow('budget')
})
