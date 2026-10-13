// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { biometricManifest, defaultConfig, manifestHash } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'
import { ShadowActiveReader } from '../active-reader'
import { ShadowStore } from '../store'
import { ShadowStreamJoin } from '../stream-join'
const start = 1700000000000, hash = configHash(defaultConfig)
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function setup(maximumRows = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-active-')), path = join(directory, 'biometrics.db')
  const writer = new Database(path)
  writer.pragma('journal_mode = WAL')
  migrate(drizzle(writer), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
  const readonly = new Database(path, { readonly: true, fileMustExist: true })
  cleanups.push(() => {
    readonly.close()
    writer.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const runId = randomUUID()
  const bundle = { schemaVersion: 1, manifestHash, resolved: defaultConfig, generation: 0, revisionId: null,
    components: biometricManifest.components, sourceHashes: biometricManifest.sourceHashes }
  writer.prepare('INSERT INTO biometric_processing_runs (id, side, kind, bundle, config_hash, calibration_hash, input_identity, started_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .run(runId, 'left', 'live', JSON.stringify(bundle), hash, JSON.stringify({ sourceSide: 'right', timestampBasis: 'processing_clock', rawIdentity: 'not_retained', sensorCalibration: 'not_consumed' }), start)
  const options = { side: 'left', startMs: start, endMs: start + 10000, activeConfigHash: hash, maximumRows }
  let now = start
  const reader = () => new ShadowActiveReader(readonly, options, () => now)
  const insert = (seconds = 0, side = 'left', provenance: string | null = runId) => {
    const id = Number(writer.prepare('INSERT INTO vitals (side,timestamp,heart_rate,hrv,breathing_rate,processing_run_id) VALUES (?,?,60,NULL,12,?)').run(side, start / 1000 + seconds, provenance).lastInsertRowid)
    writer.prepare('INSERT INTO vitals_quality (vitals_id,side,timestamp,quality_score,created_at) VALUES (?,?,?,0.9,?)').run(id, side, start / 1000 + seconds, start / 1000 + seconds)
    return id
  }
  return { writer, readonly, runId, bundle, options, reader, insert, advance: (milliseconds: number) => {
    now += milliseconds
  } }
}
it('captures only newly inserted rows with original values, quality and verified live provenance', () => {
  const { reader, insert, advance, runId } = setup()
  insert()
  const capture = reader()
  expect(capture.poll()).toEqual([])
  advance(1000)
  insert(1)
  const rows = capture.poll()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ timestampMs: start + 1000, configHash: hash, inputHash: null,
    provenance: { processingRunId: runId, sourceSide: 'right', generation: 0, manifestHash },
    readings: [{ metric: 'heart_rate', value: 60, quality: 0.9 }, { metric: 'breathing_rate', value: 12 }, { metric: 'window_ibi_variability_v1', value: null, windowMs: 300000 }] })
  expect(capture.poll()).toEqual([])
})
it('requires read-only access and never writes through the capture connection', () => {
  const { writer, readonly, options, reader, insert } = setup()
  expect(() => new ShadowActiveReader(writer, options)).toThrow(/read-only/)
  const capture = reader()
  insert()
  expect(capture.poll()).toHaveLength(1)
  expect(() => readonly.prepare('DELETE FROM vitals').run()).toThrow(/readonly/)
})
it('advances past other-side and out-of-window inserts without labelling them active', () => {
  const { reader, insert } = setup()
  const capture = reader()
  insert(0, 'right')
  insert(-1)
  expect(capture.poll()).toEqual([])
  insert()
  expect(capture.poll()).toHaveLength(1)
})
it('refuses a batch above the poll quota without silently taking a prefix', () => {
  const { reader, insert, advance } = setup(1)
  const capture = reader()
  insert()
  advance(1000)
  insert(1)
  expect(() => capture.poll()).toThrow(/quota/)
  expect(() => capture.poll()).toThrow(/quota/)
})
it.each(['legacy', 'quality_missing', 'quality_duplicate', 'quality_side', 'quality_timestamp', 'quality_invalid', 'config', 'bundle', 'kind', 'source', 'future'])('fails closed for %s evidence', (mode) => {
  const { reader, insert, writer, runId } = setup()
  const capture = reader()
  const id = insert(mode === 'future' ? 1 : 0, 'left', mode === 'legacy' ? null : runId)
  if (mode === 'quality_missing') writer.prepare('DELETE FROM vitals_quality').run()
  if (mode === 'quality_duplicate') writer.prepare('INSERT INTO vitals_quality (vitals_id,side,timestamp,quality_score,created_at) SELECT vitals_id,side,timestamp,quality_score,created_at FROM vitals_quality').run()
  if (mode === 'quality_side') writer.prepare('UPDATE vitals_quality SET side=\'right\' WHERE vitals_id=?').run(id)
  if (mode === 'quality_timestamp') writer.prepare('UPDATE vitals_quality SET timestamp=timestamp+1').run()
  if (mode === 'quality_invalid') writer.prepare('UPDATE vitals_quality SET quality_score=2').run()
  if (mode === 'config') writer.prepare('UPDATE biometric_processing_runs SET config_hash=?').run('b'.repeat(64))
  if (mode === 'bundle') writer.prepare('UPDATE biometric_processing_runs SET bundle=?').run('x'.repeat(65537))
  if (mode === 'kind') writer.prepare('UPDATE biometric_processing_runs SET kind=\'replay\'').run()
  if (mode === 'source') writer.prepare('UPDATE biometric_processing_runs SET input_identity=?').run('{}')
  expect(() => capture.poll()).toThrow()
  expect(() => capture.poll()).toThrow()
})
it('detects deletion or replacement of its cursor instead of resuming through a reset', () => {
  const { reader, insert, writer } = setup()
  insert()
  const capture = reader()
  writer.prepare('UPDATE vitals SET heart_rate=99').run()
  expect(() => capture.poll()).toThrow(/cursor changed/)
  writer.prepare('DELETE FROM vitals').run()
  expect(() => capture.poll()).toThrow(/cursor changed/)
})
it('retains active run provenance when the stream join persists an active-only point', () => {
  const { reader, insert, writer, runId } = setup()
  const capture = reader()
  const store = new ShadowStore(writer, { maximumRuns: 10, maximumPoints: 10, maximumBytes: 100000 }, () => start)
  const run = store.create({ schema: 'biometric-shadow-plan-v1', subjectId: 'test', side: 'left', candidateConfigHash: hash, activeConfigHash: hash,
    qualificationHash: hash, engineBuildHash: hash, startMs: start, endMs: start + 1000, maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 1, drainGraceMs: 100 }, monitoring: { expectedIntervalMs: 1000, maximumGapMs: 1000, heartbeatStaleMs: 1000,
      minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8, alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }, 'test')
  const lease = store.claim(run.id, 1000, () => {})
  const stream = new ShadowStreamJoin(store, lease)
  insert()
  stream.active(capture.poll()[0])
  stream.advance(start + 1)
  expect(store.snapshot(run.id, { maximumPoints: 10, maximumBytes: 10000 }).samples[0]).toMatchObject({
    inputHash: null, inputIdentityKind: 'unavailable', activeProvenance: { processingRunId: runId, sourceSide: 'right' }, pairing: { activePresent: true, candidatePresent: false } })
})
it.each(['manifestHash', 'components', 'sourceHashes', 'resolved'])('rejects substituted %s in a live run bundle', (field) => {
  const { reader, insert, writer, bundle } = setup()
  const capture = reader()
  insert()
  writer.prepare('UPDATE biometric_processing_runs SET bundle=?').run(JSON.stringify({ ...bundle, [field]: field === 'manifestHash' ? 'a'.repeat(64) : {} }))
  expect(() => capture.poll()).toThrow()
  writer.prepare('UPDATE biometric_processing_runs SET bundle=?').run(JSON.stringify(bundle))
  // Failed validation did not advance the cursor or hide this observation.
  expect(capture.poll()).toHaveLength(1)
})
