// @vitest-environment node
import Database from 'better-sqlite3'
import { build } from 'esbuild'
import { BacktestJobStore } from '../jobs'
import { DatasetStore } from '../datasets'
import { workerBuildHash } from '../child'
import { backtestFixture } from './fixtures/backtest'
import { datasetManifestSchema } from '../contracts'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { performCoordinatorTask, type CoordinatorTask } from '../coordinator-tasks'
import { runRawInspectionChild } from '../raw-inspection-child'
import type * as RawInspection from '../raw-inspection-child'
import { runRawCollectionChild } from '../raw-collection-child'

vi.mock('../raw-inspection-child', async original => ({ ...await original<typeof RawInspection>(), runRawInspectionChild: vi.fn() }))
vi.mock('../raw-collection-child', () => ({ runRawCollectionChild: vi.fn() }))
let directory: string, sqlite: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
let controller: AbortController
let admit: ReturnType<typeof vi.fn<() => Promise<boolean>>>
const location = { pythonPath: '/trusted/python', modulesPath: '/trusted/modules', archiveDirectory: '/trusted/archive' }
const execute = (task: CoordinatorTask) => performCoordinatorTask(db, task, { workerPath: '/trusted/worker', rawLocation: location, signal: controller.signal, admit })
const scan = () => execute({ type: 'inspectRawSource', input: { afterName: 'previous.RAW.gz' } })
const deferred = { status: 'deferred', nextCursor: 'previous.RAW.gz' }
function inspection() {
  const hash = 'a'.repeat(64)
  return { source_name: 'capture.RAW.gz', retained: false as const, artifact: { name: `${hash}.RAW.gz`, sha256: hash, compressed_bytes: 100, expanded_bytes: 200 },
    inventory: { version: 'retained-raw-inventory-v1' as const, artifact_sha256: hash,
      decoded_records: 2, piezo_records: 1, pump_records: 1, usable_dual_frames: 1, empty_channel_frames: 0,
      oversize_channel_frames: 0, invalid_timestamps: 0, timestamp_reversals: 0, duplicate_timestamps: 0,
      first_event_ms: 1000, last_event_ms: 2000,
      channels: { left1: { samples: 10, lost_markers: 0, truncated_tail_bytes: 0 }, right1: { samples: 10, lost_markers: 0, truncated_tail_bytes: 0 } },
      ordered_waveform_available: true, limitations: [] } }
}
beforeEach(() => {
  vi.clearAllMocks()
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-tasks-')))
  sqlite = new Database(join(directory, 'biometrics.db'))
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  controller = new AbortController()
  admit = vi.fn().mockResolvedValue(true)
  vi.mocked(runRawInspectionChild).mockReset().mockResolvedValue({ status: 'complete', nextCursor: null })
  vi.mocked(runRawCollectionChild).mockReset().mockResolvedValue({ version: 'raw-collection-result-v1', released: 0, orphans: 0 })
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
  rmSync(directory, { recursive: true, force: true })
})

it('retains an immutable dataset, releases it, and leaves canonical observations intact', async () => {
  const start = 1791673200000
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start), heartRate: 65 }).run()
  const input = { side: 'left' as const, subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'one' }
  const dataset = await execute({ type: 'createDataset', input }) as { id: string, contentHash: string }
  expect(await execute({ type: 'createDataset', input })).toEqual(dataset)
  expect(await execute({ type: 'datasetDescriptor', input: { id: dataset.id } })).toMatchObject({ contentHash: dataset.contentHash, available: true })
  await execute({ type: 'releaseDataset', input: { id: dataset.id } })
  expect(await execute({ type: 'datasetDescriptor', input: { id: dataset.id } })).toMatchObject({ available: false })
  expect(sqlite.prepare('SELECT heart_rate FROM vitals').all()).toEqual([{ heart_rate: 65 }])
})

it.each(['readResult', 'readSummary', 'releaseResult'] as const)('returns no %s for an unknown experiment without creating rows', async (type) => {
  const id = randomUUID()
  await expect(execute(type === 'releaseResult' ? { type, input: { id, expectedContentHash: 'a'.repeat(64) } } : { type, input: { id } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_experiments').get()).toEqual({ n: 0 })
})

it('refuses caller-supplied execution paths before inspecting or collecting', async () => {
  await expect(performCoordinatorTask(db, { type: 'inspectRawSource', input: { afterName: null }, workerPath: '/untrusted' }, { workerPath: '/trusted', signal: controller.signal, admit })).rejects.toThrow()
  expect(runRawInspectionChild).not.toHaveBeenCalled()
  expect(admit).not.toHaveBeenCalled()
})

it.each(['cancelled', 'denied'] as const)('does not launch a %s inspection or collection', async (reason) => {
  if (reason === 'cancelled') controller.abort()
  else admit.mockResolvedValue(false)
  expect(await scan()).toEqual(deferred)
  expect(await execute({ type: 'collectArtifacts' })).toBeNull()
  expect(runRawInspectionChild).not.toHaveBeenCalled()
  expect(runRawCollectionChild).not.toHaveBeenCalled()
})

it('records inspected evidence only after rechecking admission and pages the retained identity', async () => {
  vi.mocked(runRawInspectionChild).mockResolvedValue({ status: 'inspected', nextCursor: 'capture.RAW.gz', inspection: inspection() })
  const result = await scan()
  expect(result).toMatchObject({ status: 'inspected', source: { inspection: inspection(), availability: 'requires_reverification' } })
  expect(admit).toHaveBeenCalledTimes(2)
  expect(await execute({ type: 'pageRawSources', input: { startMs: 1000, endMs: 3000 } })).toMatchObject({ items: [expect.objectContaining({ inspection: inspection() })], nextCursor: null })
})

it('discards inspected evidence when final admission is denied', async () => {
  vi.mocked(runRawInspectionChild).mockResolvedValue({ status: 'inspected', nextCursor: 'capture.RAW.gz', inspection: inspection() })
  admit.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  expect(await scan()).toEqual(deferred)
  expect(await execute({ type: 'pageRawSources', input: { startMs: 1000, endMs: 3000 } })).toMatchObject({ items: [] })
})

it('passes through archive unavailability and propagates actual inspection failures', async () => {
  vi.mocked(runRawInspectionChild).mockResolvedValueOnce({ status: 'archive_unavailable', nextCursor: null }).mockRejectedValueOnce(new Error('decoder failed'))
  expect(await scan()).toEqual({ status: 'archive_unavailable', nextCursor: null })
  await expect(scan()).rejects.toThrow('decoder failed')
})

it.each(['denied', 'admission_error'] as const)('cancels an in-flight inspection on %s without persisting evidence', async (reason) => {
  vi.useFakeTimers()
  vi.mocked(runRawInspectionChild).mockImplementation(async (_location, _input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }))
  if (reason === 'denied') admit.mockResolvedValueOnce(true).mockResolvedValue(false)
  else admit.mockResolvedValueOnce(true).mockRejectedValue(new Error('health unavailable'))
  const running = scan()
  await vi.advanceTimersByTimeAsync(5000)
  expect(await running).toEqual(deferred)
  expect(vi.getTimerCount()).toBe(0)
})

it('forwards caller cancellation to inspection and removes its health timer', async () => {
  vi.useFakeTimers()
  vi.mocked(runRawInspectionChild).mockImplementation(async (_location, _input, options) => {
    controller.abort()
    expect(options?.signal?.aborted).toBe(true)
    return { status: 'complete', nextCursor: null }
  })
  expect(await scan()).toEqual(deferred)
  expect(vi.getTimerCount()).toBe(0)
})

it('collects only beside the actual database with fixed deployment paths', async () => {
  expect(await execute({ type: 'collectArtifacts' })).toBeNull()
  expect(runRawCollectionChild).toHaveBeenCalledExactlyOnceWith({ ...location, databasePath: join(directory, 'biometrics.db'), retainedDirectory: join(directory, 'biometric-raw') }, { signal: expect.any(AbortSignal) })
})

it('cancels collection after a failed health recheck and clears supervision', async () => {
  vi.useFakeTimers()
  let aborted = false
  vi.mocked(runRawCollectionChild).mockImplementation(async (_location, options) => new Promise((resolve) => {
    options?.signal?.addEventListener('abort', () => {
      aborted = true
      resolve({ version: 'raw-collection-result-v1', released: 0, orphans: 0 })
    }, { once: true })
  }))
  admit.mockResolvedValueOnce(true).mockRejectedValue(new Error('health unavailable'))
  const running = execute({ type: 'collectArtifacts' })
  await vi.advanceTimersByTimeAsync(5000)
  expect(await running).toBeNull()
  expect(aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('dispatches a retained evaluation through publication, paged traces and hash-fenced release', async () => {
  const start = 1791673200000
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start), heartRate: 65 }).run()
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'evaluation' })
  const fixture = backtestFixture().job
  const experiment = await execute({ type: 'createExperiment', input: { datasetId: dataset.id, protocol: fixture.protocol, idempotencyKey: 'experiment' } }) as { id: string }
  const workerPath = join(directory, 'worker.cjs')
  await build({ entryPoints: ['src/biometrics/backtest/worker-entry.ts'], outfile: workerPath, bundle: true, platform: 'node', target: 'node22', format: 'cjs' })
  const jobs = new BacktestJobStore(db)
  const job = jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: await workerBuildHash(workerPath), configs: fixture.configs, split: 'tuning', idempotencyKey: 'job' })
  const before = sqlite.prepare('SELECT * FROM vitals').all()
  expect(await performCoordinatorTask(db, { type: 'execute', owner: 'test' }, { workerPath, signal: controller.signal, admit })).toEqual({ state: 'succeeded', jobId: job.id })
  const result = await execute({ type: 'readResult', input: { id: job.id } }) as NonNullable<ReturnType<BacktestJobStore['result']>>
  expect(result.available).toBe(true)
  expect(await execute({ type: 'readSummary', input: { id: job.id } })).toMatchObject({ contentHash: result.contentHash, contentHashScope: 'complete_retained_report' })
  const trace = { id: job.id, configuration: 'default' as const, expectedContentHash: result.contentHash }
  expect(await execute({ type: 'readTrace', input: trace })).toMatchObject({ provenance: 'versioned_stage_replay', downsampled: false })
  await expect(execute({ type: 'readNumericTrace', input: { ...trace, expectedContentHash: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const cohortId = datasetManifestSchema.parse(dataset.manifest).splitProtocol.assignments[0].cohortId
  expect(await execute({ type: 'readReferenceTrace', input: { id: job.id, expectedContentHash: result.contentHash, cohortId, metric: 'heart_rate' } })).toMatchObject({ totalItems: 0, items: [], provenance: 'frozen_dataset_reference' })
  await expect(execute({ type: 'releaseResult', input: { id: job.id, expectedContentHash: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(await execute({ type: 'releaseResult', input: { id: job.id, expectedContentHash: result.contentHash } })).toMatchObject({ available: false, report: null })
  await expect(execute({ type: 'readTrace', input: trace })).rejects.toMatchObject({ code: 'RESULT_RELEASED' })
  expect(sqlite.prepare('SELECT * FROM vitals').all()).toEqual(before)
})

it('does not overlap slow health rechecks and waits for a pending denial before committing inspection', async () => {
  vi.useFakeTimers()
  let resolveHealth!: (allowed: boolean) => void
  admit.mockResolvedValueOnce(true).mockImplementation(() => new Promise((resolve) => {
    resolveHealth = resolve
  }))
  let resolveScan!: (result: Awaited<ReturnType<typeof runRawInspectionChild>>) => void
  vi.mocked(runRawInspectionChild).mockImplementation(() => new Promise((resolve) => {
    resolveScan = resolve
  }))
  const running = scan()
  await vi.advanceTimersByTimeAsync(15000)
  expect(admit).toHaveBeenCalledTimes(2)
  resolveScan({ status: 'complete', nextCursor: null })
  resolveHealth(false)
  expect(await running).toEqual(deferred)
  expect(vi.getTimerCount()).toBe(0)
})
