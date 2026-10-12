// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import * as configSchema from '@/src/db/schema'
import { DEFAULT_STAGE_CLASSIFIER } from '@/src/lib/sleep-stage-rules'
import { ProfileStore } from '@/src/biometrics/profiles/store'

const holder = vi.hoisted(() => ({ bio: null as unknown, config: null as unknown }))
vi.mock('@/src/db', () => ({
  get db() { return holder.config },
  get biometricsDb() { return holder.bio },
}))
vi.mock('@/src/biometrics/backtest/location', () => ({ packagedWorkerPath: () => '/server-owned/worker.cjs' }))
vi.mock('@/src/biometrics/backtest/child', () => ({ workerBuildHash: async () => 'f'.repeat(64) }))
const { biometricTuningRouter } = await import('../biometricTuning')
const caller = biometricTuningRouter.createCaller({})
let sqlite: Database.Database
let configSqlite: Database.Database
const input = { side: 'left' as const, source: 'generic-test', subjectId: 'sleeper-A', rows: [
  { recordKey: 'hr-1', metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: 1791673200000 },
] }

beforeEach(() => {
  sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  holder.bio = db
  configSqlite = new Database(':memory:')
  const configDb = drizzle(configSqlite, { schema: configSchema })
  migrate(configDb, { migrationsFolder: 'src/db/migrations' })
  holder.config = configDb
})
afterEach(() => {
  sqlite.close()
  configSqlite.close()
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
    expect(manifest.activationAvailable).toBe(false)
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
      desired: { isDefault: true, binding: { generation: 0 } }, runtimeStatus: 'unreported', runtimeHealth: { state: 'unreported' }, activationAvailable: false,
    })
    expect(configSqlite.prepare('SELECT count(*) AS total FROM biometric_config_outbox').get()).toEqual({ total: 0 })
    await expect(caller.createProfileRevision({ ...request, overrides: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(caller.resolveProfile({ overrides: [{ path: 'heart_rate.madeUp', value: 1 }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
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
    expect(document.paths?.['/biometric-tuning/references/preview']?.post).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/{id}/measurements']?.get).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/{id}']?.delete).toBeDefined()
  })
})
