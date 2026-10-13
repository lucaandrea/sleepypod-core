// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { dataHash } from '../../algorithms/canonical'
import { DatasetStore } from '../datasets'
import { datasetManifestSchema } from '../contracts'
import { prepareWaveformDataset } from '../waveform-dataset'
import { retainedWaveformInputSchema, waveformDatasetInputsSchema } from '../waveform-contracts'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let datasets: DatasetStore
let base: ReturnType<DatasetStore['read']>
const start = 1791673200000
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  for (const id of [1, 2, 3]) db.insert(schema.sleepRecords).values({ id, side: 'left',
    enteredBedAt: new Date(start + id * 86400000), leftBedAt: new Date(start + id * 86400000 + 3600000),
    sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  datasets = new DatasetStore(db)
  base = datasets.read(datasets.create({ side: 'left', subjectId: 'fixture', sessionIds: [1, 2, 3],
    referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'base' }).id)
})
afterEach(() => sqlite.close())
function inputs() {
  return datasetManifestSchema.parse(base.manifest).splitProtocol.assignments.map((cohort, index) => ({
    cohortId: cohort.cohortId,
    input: { version: 'retained-waveform-input-v1' as const, retained_start_ms: cohort.startMs - 300000,
      score_start_ms: cohort.startMs, score_end_ms: cohort.endMs, contexts: [],
      artifacts: [{ artifact: { name: `${String(index + 1).repeat(64)}.RAW.gz`, sha256: String(index + 1).repeat(64), compressed_bytes: 100, expanded_bytes: 200 },
        first_event_ms: cohort.startMs - 300000, last_event_ms: cohort.endMs - 1 }] },
  }))
}
function source() {
  return { ...base, manifest: datasetManifestSchema.parse(base.manifest) }
}

it('creates a separate immutable snapshot with stable request/content hashes and original observations', () => {
  const before = structuredClone(base)
  const first = prepareWaveformDataset(source(), inputs().reverse(), 'raw', 1000)
  const retry = prepareWaveformDataset(source(), inputs(), 'raw', 2000)
  expect(first.requestHash).toBe(retry.requestHash)
  expect(first.contentHash).toBe(retry.contentHash)
  expect(first.id).not.toBe(retry.id)
  expect(base).toEqual(before)
  expect(first.snapshot.sessions).toEqual(base.snapshot.sessions)
  expect(first.manifest.parentDataset).toEqual({ id: base.id, contentHash: base.contentHash })
  expect(first.manifest.capabilities.signalReplay).toBe(true)
  expect(first.contentHash).toBe(dataHash({ manifest: first.manifest, snapshot: first.snapshot }))
  expect(datasets.list('left')).toHaveLength(1) // Preparation performs no publication.
})

it('preserves waveform inputs through the shared dataset reader and detects later corruption', () => {
  const prepared = prepareWaveformDataset(source(), inputs(), 'raw')
  db.insert(schema.biometricDatasets).values({ ...prepared,
    byteLength: Buffer.byteLength(JSON.stringify(prepared.manifest)) + Buffer.byteLength(JSON.stringify(prepared.snapshot)) }).run()
  const retained = datasets.read(prepared.id)
  expect(retained.snapshot).toEqual(prepared.snapshot)
  sqlite.prepare('UPDATE biometric_datasets SET snapshot = json_set(snapshot, \'$.waveformInputs[0].input.artifacts[0].artifact.expanded_bytes\', 999) WHERE id = ?').run(prepared.id)
  expect(() => datasets.read(prepared.id)).toThrow('integrity')
})

it('rejects missing, duplicated and mismatched whole-night inputs and forged source identity', () => {
  expect(() => prepareWaveformDataset(source(), inputs().slice(1), 'raw')).toThrow('every whole-night')
  const duplicated = inputs()
  duplicated[1] = duplicated[0]
  expect(() => prepareWaveformDataset(source(), duplicated, 'raw')).toThrow('each waveform cohort once')
  const wrongWindow = inputs()
  wrongWindow[0].input.score_start_ms++
  expect(() => prepareWaveformDataset(source(), wrongWindow, 'raw')).toThrow('whole-night cohort')
  expect(() => prepareWaveformDataset({ ...source(), contentHash: '0'.repeat(64) }, inputs(), 'raw')).toThrow('integrity')
})

it('rejects overlapping source/context windows, invalid modes and inconsistent shared evidence', () => {
  const input = inputs()[0].input
  expect(() => retainedWaveformInputSchema.parse({ ...input, artifacts: [...input.artifacts, input.artifacts[0]] })).toThrow('distinct')
  const context = { start_ms: input.retained_start_ms, end_ms: input.score_end_ms,
    active_sides: ['right', 'left'], left_occupied: null, right_occupied: null, pump_context_known: false }
  expect(() => retainedWaveformInputSchema.parse({ ...input, contexts: [context] })).toThrow('sleeper mode')
  expect(() => retainedWaveformInputSchema.parse({ ...input, contexts: [{ ...context, active_sides: null }, { ...context, active_sides: null }] })).toThrow('nonoverlapping')
  const shared = [{ cohortId: 'one', input }, { cohortId: 'two', input: structuredClone(input) }]
  expect(waveformDatasetInputsSchema.parse(shared)).toEqual(shared)
  shared[1].input.artifacts[0].artifact.expanded_bytes++
  expect(() => waveformDatasetInputsSchema.parse(shared)).toThrow('Conflicting evidence')
})

it('detaches opaque historical context from caller-owned objects before hashing', () => {
  const mutable = source()
  const interval = { start: start + 1, end: start + 2 }
  mutable.snapshot.sessions[0].presentIntervals = [interval]
  mutable.contentHash = dataHash({ manifest: mutable.manifest, snapshot: mutable.snapshot })
  const prepared = prepareWaveformDataset(mutable, inputs(), 'raw')
  interval.end++
  expect(prepared.snapshot.sessions[0].presentIntervals).toEqual([{ start: start + 1, end: start + 2 }])
  expect(dataHash({ manifest: prepared.manifest, snapshot: prepared.snapshot })).toBe(prepared.contentHash)
})
