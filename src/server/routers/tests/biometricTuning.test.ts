import { RawSourceCatalog } from '@/src/biometrics/backtest/raw-catalog'
import { waveformSelectionRequestHash } from '@/src/biometrics/backtest/waveform-selection'
// @vitest-environment node
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { stopBiometricCoordinator } from '@/src/biometrics/backtest/coordinator-service'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import * as configSchema from '@/src/db/schema'
import { DEFAULT_STAGE_CLASSIFIER } from '@/src/lib/sleep-stage-rules'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { backtestFixture } from '@/src/biometrics/backtest/tests/fixtures/backtest'
import { BacktestJobStore } from '@/src/biometrics/backtest/jobs'
import { resolveSubmissionBuild } from '@/src/biometrics/backtest/submission'
import { deliverRuntimeOutbox } from '@/src/biometrics/profiles/runtime'
import { DatasetStore } from '@/src/biometrics/backtest/datasets'
import { datasetManifestSchema } from '@/src/biometrics/backtest/contracts'
import { prepareWaveformDataset } from '@/src/biometrics/backtest/waveform-dataset'
import { waveformEvaluatorBuildIdentity } from '@/src/biometrics/backtest/waveform-build'
import { ProfileStore } from '@/src/biometrics/profiles/store'

const holder = vi.hoisted(() => ({ bio: null as unknown, config: null as unknown, coordinator: '' }))
vi.mock('@/src/db', () => ({
  get db() { return holder.config },
  get biometricsDb() { return holder.bio },
}))
vi.mock('@/src/biometrics/backtest/location', () => ({ packagedWorkerPath: () => '/server-owned/worker.cjs', packagedCoordinatorPath: () => holder.coordinator }))
vi.mock('@/src/biometrics/backtest/waveform-build', () => ({ waveformEvaluatorBuildIdentity: vi.fn(async () => ({ hash: 'e'.repeat(64), python: { hash: 'a'.repeat(64) } })) }))
vi.mock('@/src/biometrics/backtest/child', () => ({ workerBuildHash: async () => 'f'.repeat(64) }))
const { biometricTuningRouter } = await import('../biometricTuning')
const caller = biometricTuningRouter.createCaller({})
let sqlite: Database.Database
let configSqlite: Database.Database
const input = { side: 'left' as const, source: 'generic-test', subjectId: 'sleeper-A', rows: [
  { recordKey: 'hr-1', metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: 1791673200000 },
] }

let bundleDirectory: string
let databaseDirectory: string
beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(tmpdir(), 'biometric-api-worker-'))
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', bundleDirectory])
  holder.coordinator = join(bundleDirectory, 'coordinator.cjs')
})
afterAll(async () => rm(bundleDirectory, { recursive: true, force: true }))
beforeEach(async () => {
  databaseDirectory = await mkdtemp(join(tmpdir(), 'biometric-api-db-'))
  sqlite = new Database(join(databaseDirectory, 'biometrics.db'))
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  holder.bio = db
  configSqlite = new Database(':memory:')
  const configDb = drizzle(configSqlite, { schema: configSchema })
  migrate(configDb, { migrationsFolder: 'src/db/migrations' })
  holder.config = configDb
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await stopBiometricCoordinator()
  sqlite.close()
  configSqlite.close()
  await rm(databaseDirectory, { recursive: true, force: true })
})

describe('shared biometric reference API', () => {
  it('completes preview, commit, paginated read and explicit deletion without touching live vitals', async () => {
    const preview = await caller.previewImport(input)
    expect(preview).toMatchObject({ accepted: 1, rejected: 0, side: 'left', subjectId: 'sleeper-A' })
    expect('measurements' in preview).toBe(false)
    const committed = await caller.commitImport({ import: input, previewHash: preview.contentHash })
    expect((await caller.listImports({ side: 'left' })).items[0].id).toBe(committed.id)
    expect((await caller.listImports({ side: 'right' })).items).toEqual([])
    expect((await caller.getImportMeasurements({ id: committed.id, limit: 1 })).items[0].value).toBe(60)
    expect(await caller.commitImport({ import: input, previewHash: preview.contentHash })).toMatchObject({ id: committed.id, alreadyImported: true })
    await caller.deleteImport({ id: committed.id })
    expect(await caller.getImport({ id: committed.id })).toMatchObject({ available: false })
    await expect(caller.getImportMeasurements({ id: committed.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(sqlite.prepare('SELECT count(*) AS total FROM vitals').get()).toEqual({ total: 0 })
  })

  it('reports stale preview and partial-import errors through actionable typed envelopes', async () => {
    const preview = await caller.previewImport(input)
    await expect(caller.commitImport({ import: { ...input, subjectId: 'different-sleeper' }, previewHash: preview.contentHash })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('STALE_PREVIEW') })
    const invalid = { ...input, rows: [...input.rows, { filename: '../../etc/passwd' }] }
    const partial = await caller.previewImport(invalid)
    await expect(caller.commitImport({ import: invalid, previewHash: partial.contentHash })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('REJECTED_ROWS') })
    await expect(caller.listImports({ side: 'left', beforeCreatedAtMs: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('compares complete stored readings with exact source and side mapping without rewriting history', async () => {
    const startMs = 1791673200000
    sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)').run('left', startMs / 1000, 65)
    sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)').run('right', startMs / 1000, 120)
    const preview = await caller.previewImport(input)
    const reference = await caller.commitImport({ import: input, previewHash: preview.contentHash })
    const request = { side: 'left' as const, subjectId: input.subjectId, importId: reference.id, metric: 'heart_rate' as const, startMs, endMs: startMs + 3600000 }
    const report = await caller.compareReadings(request)
    expect(report).toMatchObject({ status: 'compared', pairedCount: 1, metrics: { mae: 5, signedBias: 5 }, provenance: [{ processingRunId: null, count: 1 }] })
    expect(report.limitations.join(' ')).toContain('legacy_unknown')
    expect((await caller.compareReadings(request)).inputHash).toBe(report.inputHash)
    await expect(caller.compareReadings({ ...request, side: 'right' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('SUBJECT_MISMATCH') })
    await expect(caller.compareReadings({ ...request, endMs: startMs + 86400001 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    sqlite.prepare('UPDATE vitals SET heart_rate = 70 WHERE side = ?').run('left')
    expect((await caller.compareReadings(request)).inputHash).not.toBe(report.inputHash)
    expect(sqlite.prepare('SELECT count(*) AS total FROM vitals').get()).toEqual({ total: 2 })
  })

  it('blocks scoring clinical HRV against the window index and reports missing readings', async () => {
    const startMs = 1791673200000
    const upload = { ...input, rows: [{ recordKey: 'rmssd', metric: 'hrv_rmssd', value: 40, unit: 'ms', timestampMs: startMs, windowMs: 300000 }] }
    sqlite.prepare('INSERT INTO vitals (side, timestamp, hrv) VALUES (?, ?, ?)').run('left', startMs / 1000, 40)
    const preview = await caller.previewImport(upload)
    const reference = await caller.commitImport({ import: upload, previewHash: preview.contentHash })
    const request = { side: 'left' as const, subjectId: input.subjectId, importId: reference.id, metric: 'hrv_rmssd' as const, startMs, endMs: startMs + 3600000 }
    expect(await caller.compareReadings(request)).toMatchObject({ status: 'incompatible', metrics: null, pairedCount: 0, exclusions: { incompatible_metric_definition: 1 } })
    const hrPreview = await caller.previewImport(input)
    const hr = await caller.commitImport({ import: input, previewHash: hrPreview.contentHash })
    expect(await caller.compareReadings({ ...request, importId: hr.id, metric: 'heart_rate' })).toMatchObject({ status: 'no_overlap', metrics: null, outputCoverage: 0 })
    await caller.deleteImport({ id: hr.id })
    await expect(caller.compareReadings({ ...request, importId: hr.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resolves and saves an exact candidate without activation, preserves explicit values and exposes revisions', async () => {
    const manifest = await caller.getManifest({})
    expect(manifest.activationAvailable).toBe(true)
    const overrides = [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }]
    const resolved = await caller.resolveProfile({ overrides })
    expect(resolved.resolved.heart_rate.trackingToleranceBpm).toBe(20)
    expect(resolved.provenance).toEqual({ 'heart_rate.trackingToleranceBpm': 'override' })
    const request = { side: 'left' as const, overrides, origin: 'agent' as const, requester: 'test', idempotencyKey: 'profile-1' }
    const revision = await caller.createProfileRevision(request)
    expect(revision.resolvedHash).toBe(resolved.hash)
    expect(await caller.validateProfileRevision({ id: revision.id, side: 'left' })).toMatchObject({ compatible: true, evidence: 'not_checked' })
    expect(await caller.diffProfileRevision({ side: 'left', revisionId: revision.id, againstRevisionId: null })).toMatchObject({ changes: [{ path: 'heart_rate.trackingToleranceBpm', after: 20 }], intentChangedPaths: ['heart_rate.trackingToleranceBpm'] })
    expect(await caller.getProfileRevision({ id: revision.id })).toEqual(revision)
    expect((await caller.listProfileRevisions({ side: 'left' })).items[0].id).toBe(revision.id)
    expect((await caller.listProfileRevisions({ side: 'right' })).items).toEqual([])
    expect(await caller.getProfileOverview({ side: 'left' })).toMatchObject({
      desired: { isDefault: true, binding: { generation: 0 } }, runtimeStatus: 'unreported', runtimeHealth: { state: 'unreported' }, activationAvailable: true,
    })
    expect(configSqlite.prepare('SELECT count(*) AS total FROM biometric_config_outbox').get()).toEqual({ total: 0 })
    await expect(caller.createProfileRevision({ ...request, overrides: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(caller.resolveProfile({ overrides: [{ path: 'heart_rate.madeUp', value: 1 }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('queues exact manual activation, rejects stale updates, and distinguishes reset from rollback', async () => {
    const defaults = await caller.resolveProfile({ overrides: [] })
    const revision = await caller.createProfileRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
      origin: 'manual', requester: 'fixture', idempotencyKey: 'revision' })
    const request = { side: 'left' as const, revisionId: revision.id, expectedGeneration: 0, expectedResolvedHash: revision.resolvedHash,
      boundary: 'next_session' as const, requester: 'fixture', idempotencyKey: 'activate', allowUnvalidated: true as const }
    await expect(caller.activateProfile({ ...request, allowUnvalidated: false as true })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const event = await caller.activateProfile(request)
    expect(event).toMatchObject({ action: 'activate', generation: 1, state: 'pending_delivery', evidence: { status: 'manual_unvalidated' } })
    expect(await caller.activateProfile(request)).toEqual(event)
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ observedState: 'pending_delivery', receipts: [], isCurrent: true })
    await expect(caller.activateProfile({ ...request, idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(caller.activateProfile({ ...request, side: 'right', idempotencyKey: 'wrong-side' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.getActivationStatus({ side: 'right', id: event.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(caller.activateProfile({ ...request, expectedGeneration: 1, expectedResolvedHash: '0'.repeat(64), idempotencyKey: 'wrong-hash' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    const reset = await caller.resetProfile({ side: 'left', expectedGeneration: 1, expectedResolvedHash: defaults.hash,
      boundary: 'immediate', requester: 'fixture', idempotencyKey: 'reset', allowUnvalidated: true })
    expect(reset.action).toBe('reset')
    const rollback = await caller.rollbackProfile({ ...request, expectedGeneration: 2, idempotencyKey: 'rollback' })
    expect(rollback).toMatchObject({ action: 'rollback', generation: 3, nextRevisionId: revision.id })
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ isCurrent: false, desiredGeneration: 3 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM vitals').get()).toEqual({ count: 0 })
  })

  it('returns side-scoped activation history and rejects malformed cursors', async () => {
    const configDb = holder.config as ReturnType<typeof drizzle<typeof configSchema>>
    configDb.insert(configSchema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: DEFAULT_STAGE_CLASSIFIER }).run()
    new ProfileStore(configDb).migrateLegacy('left')
    const history = await caller.listActivationHistory({ side: 'left' })
    expect(history.items).toHaveLength(1)
    expect(history.items[0]).toMatchObject({ action: 'migration', generation: 1, state: 'pending_delivery' })
    expect(history.items[0]).not.toHaveProperty('requestHash')
    expect((await caller.listActivationHistory({ side: 'right' })).items).toEqual([])
    await expect(caller.listActivationHistory({ side: 'left', beforeGeneration: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('reports legacy stage personalization and expired sensor calibration without fabricating runtime adoption', async () => {
    const configDb = holder.config as ReturnType<typeof drizzle<typeof configSchema>>
    configDb.insert(configSchema.sideSettings).values({ side: 'left', name: 'Left', stageClassifier: DEFAULT_STAGE_CLASSIFIER }).run()
    const bio = holder.bio as ReturnType<typeof drizzle<typeof schema>>
    bio.insert(schema.calibrationProfiles).values({ side: 'left', sensorType: 'piezo', status: 'completed', parameters: {}, qualityScore: 0.8,
      createdAt: new Date(1700000000000), expiresAt: new Date(1700000100000), sourceWindowStart: 1700000000, sourceWindowEnd: 1700000060 }).run()
    expect(await caller.getProfileOverview({ side: 'left' })).toMatchObject({
      legacyStageView: { personalized: true, migrationPending: true }, runtimeStatus: 'unreported',
      sensorCalibration: [{ freshness: 'expired', sourceWindowStartMs: 1700000000000, sourceWindowEndMs: 1700000060000 }],
    })
  })

  it('freezes selected sessions using the device timezone and returns bounded metadata without raw readings', async () => {
    const configDb = holder.config as ReturnType<typeof drizzle<typeof configSchema>>
    configDb.insert(configSchema.deviceSettings).values({ timezone: 'Europe/London' }).run()
    const bio = holder.bio as ReturnType<typeof drizzle<typeof schema>>
    bio.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(1791673200000), leftBedAt: new Date(1791676800000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
    const dataset = await caller.createDataset({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], idempotencyKey: 'api-dataset' })
    expect(dataset.manifest.splitProtocol.timezone).toBe('Europe/London')
    expect('snapshot' in dataset).toBe(false)
    expect((await caller.listDatasets({ side: 'left' })).items[0].id).toBe(dataset.id)
    expect(await caller.getDataset({ id: dataset.id })).toEqual(dataset)
    expect((await caller.listDatasets({ side: 'right' })).items).toEqual([])
    await expect(caller.createDataset({ side: 'right', subjectId: 'A', sessionIds: [1], referenceImportIds: [], idempotencyKey: 'wrong-side' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('submits server-resolved baselines, rejects stale edits, retries identically and cancels without activating', async () => {
    const bio = holder.bio as ReturnType<typeof drizzle<typeof schema>>
    bio.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(1791673200000), leftBedAt: new Date(1791676800000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
    const dataset = await caller.createDataset({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], idempotencyKey: 'queue-dataset' })
    const experiment = await caller.createExperiment({ datasetId: dataset.id, idempotencyKey: 'api-experiment', protocol: { version: 'descriptive-evaluation-v1', mode: 'stage_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 } })
    expect((await caller.createExperiment({ datasetId: dataset.id, idempotencyKey: 'api-experiment', protocol: experiment.protocol })).id).toBe(experiment.id)
    await expect(caller.createExperiment({ datasetId: dataset.id, idempotencyKey: 'api-experiment', protocol: { ...experiment.protocol, clockOffsetMs: 1000 } })).rejects.toMatchObject({ code: 'CONFLICT' })
    const candidate = await caller.createProfileRevision({ side: 'left', origin: 'manual', requester: 'fixture', idempotencyKey: 'candidate', overrides: [] })
    expect(await caller.getExperiment({ id: experiment.id })).toEqual(experiment)
    expect((await caller.listExperiments({ side: 'left' })).items[0].id).toBe(experiment.id)
    expect((await caller.listExperiments({ side: 'right' })).items).toEqual([])
    const request = { experimentId: experiment.id, candidateRevisionId: candidate.id, expectedBindingGeneration: 0, split: 'tuning' as const, idempotencyKey: 'api-job' }
    await expect(caller.enqueueBacktest({ ...request, expectedBindingGeneration: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
    const job = await caller.enqueueBacktest(request)
    expect(job).toMatchObject({ state: 'queued', evaluationScope: 'stage_rules_on_original_readings', evaluatorBuildHash: 'f'.repeat(64) })
    expect(job.configurations.map(row => row.label)).toEqual(['default', 'current', 'candidate'])
    expect(job.configurations[2].revisionId).toBe(candidate.id)
    await expect(caller.releaseDataset({ id: dataset.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect('input' in job).toBe(false)
    expect((await caller.listBacktests({ side: 'left' })).items[0].id).toBe(job.id)
    expect((await caller.listBacktests({ side: 'right' })).items).toEqual([])
    expect(await caller.enqueueBacktest(request)).toEqual(job)
    expect(await caller.getBacktestResult({ id: job.id })).toBeNull()
    expect((await caller.cancelBacktest({ id: job.id })).state).toBe('cancelled')
    expect((await caller.getBacktest({ id: job.id })).state).toBe('cancelled')
    const completed = await caller.enqueueBacktest({ ...request, idempotencyKey: 'completed-for-release' })
    const reports = new BacktestJobStore(drizzle(sqlite, { schema }))
    const claim = reports.claim('api-fixture')
    if (!claim) throw new Error('Missing claim')
    const published = reports.complete({ id: claim.id, owner: 'api-fixture', token: claim.fencingToken }, evaluateBacktest(backtestFixture()))
    expect((await caller.getBacktestResult({ id: completed.id }))?.available).toBe(true)
    const summary = await caller.getBacktestSummary({ id: completed.id })
    expect(summary).toMatchObject({ available: true, contentHash: published.contentHash, contentHashScope: 'complete_retained_report' })
    expect(JSON.stringify(summary?.report)).not.toContain('"blocks"')
    const trace = await caller.getBacktestTrace({ id: completed.id, expectedContentHash: published.contentHash, configuration: 'default', limit: 2 })
    expect(trace).toMatchObject({ contentHash: published.contentHash, downsampled: false, provenance: 'versioned_stage_replay' })
    expect(trace.items.length).toBeGreaterThan(0)
    expect(trace.items.length).toBeLessThanOrEqual(2)
    await expect(caller.getBacktestTrace({ id: completed.id, expectedContentHash: '0'.repeat(64), configuration: 'default' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(caller.releaseBacktestResult({ id: completed.id, expectedContentHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    const releasedReport = await caller.releaseBacktestResult({ id: completed.id, expectedContentHash: published.contentHash })
    expect(releasedReport).toMatchObject({ available: false, report: null, contentHash: published.contentHash })
    await expect(caller.getBacktestTrace({ id: completed.id, expectedContentHash: published.contentHash, configuration: 'default' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await caller.getBacktestResult({ id: completed.id })).toEqual(releasedReport)
    expect(await caller.getBacktestSummary({ id: completed.id })).toMatchObject({ ...releasedReport, contentHashScope: 'complete_retained_report' })
    expect(await caller.releaseBacktestResult({ id: completed.id, expectedContentHash: published.contentHash })).toEqual(releasedReport)
    const released = await caller.releaseDataset({ id: dataset.id })
    expect(released.available).toBe(false)
    expect(await caller.releaseDataset({ id: dataset.id })).toEqual(released)
    expect(await caller.getDataset({ id: dataset.id })).toEqual(released)
    await expect(caller.enqueueBacktest({ ...request, idempotencyKey: 'released' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(configSqlite.prepare('SELECT count(*) AS total FROM biometric_config_outbox').get()).toEqual({ total: 0 })
    const right = await caller.createProfileRevision({ side: 'right', origin: 'manual', requester: 'fixture', idempotencyKey: 'right-candidate', overrides: [] })
    await expect(caller.enqueueBacktest({ ...request, candidateRevisionId: right.id, idempotencyKey: 'cross-side' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('discovers side-specific sessions and actual gaps without claiming waveform retention', async () => {
    expect((await caller.listSessions({ side: 'left' })).items).toEqual([])
    const bio = holder.bio as ReturnType<typeof drizzle<typeof schema>>
    bio.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(1791673200000), leftBedAt: new Date(1791676800000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
    bio.insert(schema.vitals).values({ side: 'left', timestamp: new Date(1791673200000), heartRate: 60 }).run()
    expect((await caller.listSessions({ side: 'left' })).items[0].id).toBe(1)
    expect((await caller.listSessions({ side: 'right' })).items).toEqual([])
    const capabilities = await caller.getSessionCapabilities({ id: 1, side: 'left' })
    expect(capabilities).toMatchObject({ stageReplay: true, comparison: true, signalReplay: false, rawWaveforms: 'not_inventoried',
      processed: { vitals: { count: 1, gapDurationMs: 3540000 }, movement: { count: 0, gapDurationMs: 3600000 }, legacyUnknownProvenanceCount: 1 } })
    await expect(caller.getSessionCapabilities({ id: 1, side: 'right' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('generates usable OpenAPI contracts for the actual shared router', () => {
    const document = generateOpenApiDocument(biometricTuningRouter, { title: 'References', version: '1.0.0', baseUrl: 'http://localhost/api' })
    expect(document.paths?.['/biometric-tuning/raw-sources/inspect']?.post).toBeDefined()
    expect(document.paths?.['/biometric-tuning/raw-sources']?.get).toBeDefined()
    expect(document.paths?.['/biometric-tuning/waveform-datasets']?.post).toBeDefined()
    expect(document.paths?.['/biometric-tuning/replay-admission']?.get).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/preview']?.post).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/{id}/measurements']?.get).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/{id}']?.delete).toBeDefined()
  })
})

it('submits waveform pins and both baseline snapshots, then retries without probing a changed runtime', async () => {
  const bio = holder.bio as ReturnType<typeof drizzle<typeof schema>>
  const start = 1791673200000
  bio.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  const parentDescriptor = await caller.createDataset({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], idempotencyKey: 'raw-parent' })
  const parent = new DatasetStore(bio).read(parentDescriptor.id)
  const manifest = datasetManifestSchema.parse(parent.manifest)
  const prepared = prepareWaveformDataset({ ...parent, manifest }, [{ cohortId: manifest.splitProtocol.assignments[0].cohortId,
    input: { version: 'retained-waveform-input-v1', retained_start_ms: start, score_start_ms: start, score_end_ms: start + 600000, contexts: [],
      artifacts: [{ artifact: { name: `${'a'.repeat(64)}.RAW.gz`, sha256: 'a'.repeat(64), compressed_bytes: 1, expanded_bytes: 2 }, first_event_ms: start, last_event_ms: start + 599999 }] } }], 'raw-fixture')
  const selection = { parentDatasetId: parent.id, expectedContentHash: parent.contentHash, idempotencyKey: 'raw-fixture',
    cohorts: [{ cohortId: manifest.splitProtocol.assignments[0].cohortId, sourceIds: ['b'.repeat(64)] }] }
  prepared.requestHash = waveformSelectionRequestHash(selection)
  bio.insert(schema.biometricDatasets).values({ ...prepared, byteLength: Buffer.byteLength(JSON.stringify(prepared)) }).run()
  // An already committed publication can be retried without current admission
  // or mutable source-catalog evidence, even when the sources have disappeared.
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', undefined)
  expect(await caller.createWaveformDataset(selection)).toMatchObject({ status: 'published', dataset: { id: prepared.id, contentHash: prepared.contentHash } })
  await expect(caller.createWaveformDataset({ ...selection, expectedContentHash: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })

  const experiment = await caller.createExperiment({ datasetId: prepared.id, idempotencyKey: 'signal-experiment', protocol: {
    version: 'descriptive-evaluation-v1', mode: 'signal_replay', waveformStages: true, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 } })
  const candidate = await caller.createProfileRevision({ side: 'left', origin: 'manual', requester: 'fixture', idempotencyKey: 'signal-candidate', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] })
  const request = { experimentId: experiment.id, candidateRevisionId: candidate.id, expectedBindingGeneration: 0, split: 'tuning' as const, idempotencyKey: 'signal-submission' }
  const job = await caller.enqueueBacktest(request)
  expect(job).toMatchObject({ state: 'queued', evaluatorBuildHash: 'e'.repeat(64), evaluationScope: 'retained_waveform_replay' })
  const saved = new BacktestJobStore(bio).get(job.id).input
  expect(saved).toMatchObject({ waveform: { pythonBuildHash: 'a'.repeat(64), baselineProvenance: {
    current: { source: 'unacknowledged_defaults' }, otherSide: { source: 'unacknowledged_defaults' } } } })
  const identity = await waveformEvaluatorBuildIdentity('fixture', 'fixture', { pythonPath: 'fixture', modulesPath: 'fixture' })
  let finishProbe = () => {}
  const pendingProbe = new Promise<typeof identity>((resolve) => {
    finishProbe = () => resolve(identity)
  })
  vi.mocked(waveformEvaluatorBuildIdentity).mockReturnValueOnce(pendingProbe)
  const previousCalls = vi.mocked(waveformEvaluatorBuildIdentity).mock.calls.length
  const firstProbe = resolveSubmissionBuild(bio, { ...request, idempotencyKey: 'probe-one' })
  const secondProbe = resolveSubmissionBuild(bio, { ...request, idempotencyKey: 'probe-two' })
  expect(vi.mocked(waveformEvaluatorBuildIdentity).mock.calls.length - previousCalls).toBe(1)
  finishProbe()
  expect(await firstProbe).toEqual(await secondProbe)
  await resolveSubmissionBuild(bio, { ...request, idempotencyKey: 'probe-three' })
  expect(vi.mocked(waveformEvaluatorBuildIdentity).mock.calls.length - previousCalls).toBe(2)
  const config = holder.config as ReturnType<typeof drizzle<typeof configSchema>>
  for (const [side, value] of [['left', 22], ['right', 12]] as const) {
    const revision = await caller.createProfileRevision({ side, origin: 'manual', requester: 'fixture', idempotencyKey: `current-${side}`, overrides: [{ path: 'heart_rate.trackingToleranceBpm', value }] })
    await caller.activateProfile({ side, revisionId: revision.id, expectedGeneration: 0, expectedResolvedHash: revision.resolvedHash,
      boundary: 'immediate', requester: 'fixture', idempotencyKey: `active-${side}`, allowUnvalidated: true })
    deliverRuntimeOutbox(config, bio)
    for (const component of ['heart_rate', 'breathing_rate', 'hrv_index']) bio.insert(schema.biometricRuntimeReceipts).values({ side, component, generation: 1,
      appliedHash: revision.resolvedHash, effectiveSampleTimeMs: start, state: 'applied', heartbeatAtMs: start }).run()
  }
  const acknowledged = await caller.enqueueBacktest({ ...request, idempotencyKey: 'acknowledged-signal', expectedBindingGeneration: 1 })
  expect(new BacktestJobStore(bio).get(acknowledged.id).input).toMatchObject({
    configs: [{ label: 'default' }, { label: 'current', resolved: { heart_rate: { trackingToleranceBpm: 22 } } }, { label: 'candidate', resolved: { heart_rate: { trackingToleranceBpm: 20 } } }],
    waveform: { otherSide: { resolved: { heart_rate: { trackingToleranceBpm: 12 } } }, baselineProvenance: {
      current: { source: 'acknowledged_runtime', generation: 1 }, otherSide: { source: 'acknowledged_runtime', generation: 1 } } },
  })
  expect(new BacktestJobStore(bio).get(job.id).input).toEqual(saved)
  vi.mocked(waveformEvaluatorBuildIdentity).mockRejectedValueOnce(new Error('Runtime changed'))
  expect(await caller.enqueueBacktest(request)).toEqual(job)
  await expect(caller.enqueueBacktest({ ...request, idempotencyKey: 'new-signal-submission' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  await expect(caller.enqueueBacktest({ ...request, expectedBindingGeneration: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
})

it('exposes bounded waveform discovery and defers new I/O without a deployment policy', async () => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', undefined)
  expect(await caller.getReplayAdmission({})).toEqual({ configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] })
  expect(await caller.listRawSources({ startMs: 0, endMs: 1000 })).toEqual({ items: [], nextCursor: null })
  expect(await caller.inspectRawSource({ afterName: null })).toEqual({ status: 'deferred', nextCursor: null })
  expect(await caller.inspectRawSource({ afterName: '001.RAW.gz' })).toEqual({ status: 'deferred', nextCursor: '001.RAW.gz' })
  await expect(caller.inspectRawSource({ afterName: '../secret.RAW.gz' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  const input = { parentDatasetId: '00000000-0000-4000-8000-000000000001', expectedContentHash: 'a'.repeat(64),
    cohorts: [{ cohortId: 'test-night', sourceIds: ['b'.repeat(64)] }], idempotencyKey: 'deferred-publication' }
  expect(await caller.createWaveformDataset(input)).toEqual({ status: 'deferred' })
  await expect(caller.createWaveformDataset({ ...input, path: '/private/source' } as typeof input)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(sqlite.prepare('SELECT count(*) n FROM biometric_datasets').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('SELECT count(*) n FROM biometric_raw_sources').get()).toEqual({ n: 0 })
  const digest = 'a'.repeat(64)
  const sourceId = new RawSourceCatalog(holder.bio as ReturnType<typeof drizzle<typeof schema>>).record({
    source_name: 'fixture.RAW.gz', retained: false,
    artifact: { name: `${digest}.RAW.gz`, sha256: digest, compressed_bytes: 100, expanded_bytes: 10000 },
    inventory: { version: 'retained-raw-inventory-v1', artifact_sha256: digest, decoded_records: 2, piezo_records: 2, pump_records: 0,
      usable_dual_frames: 2, empty_channel_frames: 0, oversize_channel_frames: 0, invalid_timestamps: 0, timestamp_reversals: 0, duplicate_timestamps: 0,
      first_event_ms: 1000, last_event_ms: 2000, ordered_waveform_available: true, limitations: [],
      channels: { left1: { samples: 1000, lost_markers: 0, truncated_tail_bytes: 0 }, right1: { samples: 1000, lost_markers: 0, truncated_tail_bytes: 0 } } },
  })
  const page = await caller.listRawSources({ startMs: 1000, endMs: 2001 })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ id: sourceId, availability: 'requires_reverification', inspection: { retained: false, source_name: 'fixture.RAW.gz' } })
  expect(await caller.listRawSources({ startMs: 1000, endMs: 2001, afterId: sourceId })).toEqual({ items: [], nextCursor: null })
})

it('exposes validated activation with exact evidence identity and rejects client build authority', async () => {
  const input = { side: 'left' as const, revisionId: '11111111-1111-4111-8111-111111111111',
    evaluationId: '22222222-2222-4222-8222-222222222222', expectedReportHash: 'a'.repeat(64), expectedResolvedHash: 'b'.repeat(64),
    expectedGeneration: 0, boundary: 'next_session' as const, requester: 'test', idempotencyKey: 'validated' }
  await expect(caller.activateValidatedProfile(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(caller.activateValidatedProfile({ ...input, evaluatorBuildHash: 'c'.repeat(64) } as typeof input)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(caller.activateValidatedProfile({ ...input, allowUnvalidated: true } as typeof input)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect((holder.config as ReturnType<typeof drizzle<typeof configSchema>>).select().from(configSchema.biometricActivationEvents).all()).toEqual([])
})
