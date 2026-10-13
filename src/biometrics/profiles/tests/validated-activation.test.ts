// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { ProfileStore } from '../store'
import { requestManualActivation, requestValidatedActivation, requestValidatedActivationWithBuild, validatedActivationReviewSchema, reviewValidatedActivation } from '../activation'
import { deliverRuntimeOutbox } from '../runtime'
import { prepareVerifiedEvaluation } from '../evaluation-store'
import { BacktestJobStore } from '../../backtest/jobs'
import { DatasetStore } from '../../backtest/datasets'
import { backtestJobSnapshotSchema, datasetManifestSchema } from '../../backtest/contracts'
import { submitBacktest } from '../../backtest/submission'
import { evaluationFixture } from './fixtures/evaluation'
import { defaultConfig } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'

let configRaw: Database.Database, bioRaw: Database.Database, observer: Database.Database
let config: ReturnType<typeof drizzle<typeof configSchema>>, bio: ReturnType<typeof drizzle<typeof bioSchema>>
let root: string
const now = 1791673200000
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'biometric-activation-'))
  configRaw = new Database(':memory:')
  bioRaw = new Database(join(root, 'bio.sqlite'))
  bioRaw.pragma('journal_mode = WAL')
  observer = new Database(join(root, 'bio.sqlite'), { timeout: 0 })
  config = drizzle(configRaw, { schema: configSchema })
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(config, { migrationsFolder: 'src/db/migrations' })
  migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
})
afterEach(() => {
  vi.restoreAllMocks()
  observer.close()
  configRaw.close()
  bioRaw.close()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const work = evaluationFixture()
  const profiles = new ProfileStore(config)
  const revision = profiles.createRevision({ side: 'left', origin: 'manual', requester: 'fixture', idempotencyKey: 'candidate',
    overrides: [{ path: 'sleep_stages.ruleset.smoothIsolatedEpochs', value: false }] })
  for (let id = 1; id <= 12; id++) bio.insert(bioSchema.sleepRecords).values({ id, side: 'left',
    enteredBedAt: new Date(now + id * 86400000), leftBedAt: new Date(now + id * 86400000 + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  const datasets = new DatasetStore(bio)
  const dataset = datasets.create({ side: 'left', subjectId: 'fixture', sessionIds: Array.from({ length: 12 }, (_, i) => i + 1),
    referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'dataset' })
  const cohorts = datasetManifestSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === 'holdout').map(row => row.cohortId)
  expect(cohorts).toHaveLength(3)
  const jobs = new BacktestJobStore(bio)
  const experiment = jobs.createExperiment(dataset.id, work.job.protocol)
  const configs = work.job.configs.map(row => row.label === 'candidate' ? { ...row, revisionId: revision.id } : row)
  const enqueue = (idempotencyKey: string) => jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: work.job.evaluatorBuildHash,
    idempotencyKey, split: 'holdout', configs })
  const job = enqueue('holdout')
  const report = { ...work.report, datasetId: dataset.id, datasetHash: dataset.contentHash, nights: cohorts.map(cohortId => ({ cohortId })) }
  for (const row of report.stageObjectiveAssessments) {
    row.evidence.nights.forEach((night, i) => {
      night.cohortId = cohorts[i]
    })
  }
  const lease = jobs.claim('fixture')
  if (!lease) throw new Error('No lease')
  const result = jobs.complete({ id: lease.id, owner: 'fixture', token: lease.fencingToken }, report)
  const input = { side: 'left' as const, action: 'activate' as const, revisionId: revision.id, expectedGeneration: 0,
    expectedResolvedHash: revision.resolvedHash, boundary: 'next_session' as const, requester: 'fixture', idempotencyKey: 'validated',
    evaluationId: job.id, expectedReportHash: result.contentHash }
  const build = { evaluatorBuildHash: work.job.evaluatorBuildHash, designations: work.designations }
  return { profiles, jobs, datasets, dataset, input, build, enqueue }
}

it('atomically stores verified evidence and outbox intent; retries survive released biometric artifacts', () => {
  const work = fixture()
  const event = requestValidatedActivation(config, bio, work.input, work.build, now)
  expect(event).toMatchObject({ state: 'pending_delivery', generation: 1, evaluationId: work.input.evaluationId,
    evidence: { status: 'validated_reference_agreement', reportHash: work.input.expectedReportHash, changedDomains: ['sleep_stages'] } })
  expect(work.profiles.binding('left').desiredRevisionId).toBe(work.input.revisionId)
  expect(work.profiles.binding('right').generation).toBe(0)
  expect(config.select().from(configSchema.biometricConfigOutbox).all()).toHaveLength(1)
  work.jobs.releaseResult(work.input.evaluationId, work.input.expectedReportHash)
  work.datasets.release(work.dataset.id)
  expect(requestValidatedActivation(config, bio, work.input, work.build, now + 1)).toEqual(event)
  expect(config.select().from(configSchema.biometricActivationEvents).all()).toHaveLength(1)
  expect(bio.select().from(bioSchema.vitals).all()).toEqual([])
})

it('rejects missing designation, mismatched hashes, and reused holdout before changing bindings', () => {
  const work = fixture()
  expect(() => requestValidatedActivation(config, bio, work.input, { ...work.build, designations: { protocolHash: null, waveformContext: null, numeric: null, stages: null } })).toThrow()
  expect(() => requestValidatedActivation(config, bio, { ...work.input, expectedReportHash: '0'.repeat(64) }, work.build)).toThrow('hash')
  work.enqueue('second-holdout')
  expect(() => requestValidatedActivation(config, bio, work.input, work.build)).toThrow('holdout')
  expect(work.profiles.binding('left').generation).toBe(0)
  expect(config.select().from(configSchema.biometricConfigOutbox).all()).toEqual([])
})

it('blocks concurrent biometrics writes across the configuration commit', () => {
  const work = fixture()
  let blocked = false
  configRaw.function('check_bio_reservation', () => {
    try {
      observer.prepare('UPDATE biometric_backtest_jobs SET updated_at_ms = updated_at_ms').run()
    }
    catch (error) { blocked = (error as { code: string }).code === 'SQLITE_BUSY' }
    return 1
  })
  configRaw.exec('CREATE TRIGGER check_lock BEFORE INSERT ON biometric_profile_bindings BEGIN SELECT check_bio_reservation(); END;')
  requestValidatedActivation(config, bio, work.input, work.build)
  expect(blocked).toBe(true)
  expect(() => observer.prepare('UPDATE biometric_backtest_jobs SET updated_at_ms = updated_at_ms').run()).not.toThrow()
})

it('rejects holdout reuse that occurs after the first verified result read', () => {
  const work = fixture()
  const original = BacktestJobStore.prototype.result
  vi.spyOn(BacktestJobStore.prototype, 'result').mockImplementationOnce(function (this: BacktestJobStore, id) {
    const result = original.call(this, id)
    work.enqueue('racing-holdout')
    return result
  })
  expect(() => requestValidatedActivation(config, bio, work.input, work.build)).toThrow('reused before activation')
  expect(work.profiles.binding('left').generation).toBe(0)
})

it('rejects report release between verification and committing intent', () => {
  const work = fixture()
  const original = BacktestJobStore.prototype.result
  const spy = vi.spyOn(BacktestJobStore.prototype, 'result').mockImplementationOnce(function (this: BacktestJobStore, id) {
    const result = original.call(this, id)
    spy.mockRestore()
    work.jobs.releaseResult(work.input.evaluationId, work.input.expectedReportHash)
    return result
  })
  expect(() => requestValidatedActivation(config, bio, work.input, work.build)).toThrow('released, replaced or reused')
  expect(work.profiles.binding('left').generation).toBe(0)
})

it.each([
  'UPDATE biometric_backtest_jobs SET state = \'failed\'',
  'UPDATE biometric_backtest_jobs SET fencing_token = fencing_token + 1',
  'DELETE FROM biometric_backtest_results',
  'UPDATE biometric_backtest_results SET fencing_token = fencing_token + 1',
  'UPDATE biometric_backtest_results SET content_hash = \'changed\'',
  'UPDATE biometric_backtest_results SET released_at_ms = 1',
  'UPDATE biometric_datasets SET content_hash = \'changed\'',
  'UPDATE biometric_datasets SET released_at_ms = 1',
])('rejects changed retained metadata at the commit guard: %s', (statement) => {
  const work = fixture()
  const prepared = prepareVerifiedEvaluation(config, bio, work.input, work.build)
  bioRaw.exec(statement)
  expect(() => prepared.recheck()).toThrow('released, replaced or reused')
  expect(work.profiles.binding('left').generation).toBe(0)
})

it('rejects pending baselines and captures the complete acknowledged bundle for subsequent stage replay', () => {
  const work = fixture()
  const revision = work.profiles.createRevision({ side: 'left', origin: 'manual', requester: 'fixture', idempotencyKey: 'numeric',
    overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] })
  requestManualActivation(config, { side: 'left', action: 'activate', revisionId: revision.id, expectedGeneration: 0,
    expectedResolvedHash: revision.resolvedHash, boundary: 'immediate', requester: 'fixture', idempotencyKey: 'numeric-activation', allowUnvalidated: true }, now)
  expect(() => requestValidatedActivation(config, bio, work.input, work.build)).toThrow('Binding changed')
  expect(() => requestValidatedActivation(config, bio, { ...work.input, expectedGeneration: 1 }, work.build)).toThrow('pending')
  deliverRuntimeOutbox(config, bio, now)
  for (const component of ['heart_rate', 'breathing_rate', 'hrv_index']) bio.insert(bioSchema.biometricRuntimeReceipts)
    .values({ side: 'left', component, generation: 1, appliedHash: revision.resolvedHash, effectiveSampleTimeMs: now, state: 'applied', heartbeatAtMs: now }).run()
  expect(() => requestValidatedActivation(config, bio, { ...work.input, expectedGeneration: 1 }, work.build)).toThrow('baseline changed')
  const experimentId = work.jobs.get(work.input.evaluationId).experimentId
  const next = submitBacktest(config, bio, work.build.evaluatorBuildHash, { experimentId, candidateRevisionId: work.input.revisionId,
    expectedBindingGeneration: 1, split: 'tuning', idempotencyKey: 'next-stage-replay' })
  expect(backtestJobSnapshotSchema.parse(next.input).configs.find(row => row.label === 'current')).toMatchObject({
    revisionId: revision.id, resolvedHash: revision.resolvedHash, resolved: { heart_rate: { trackingToleranceBpm: 20 } } })
})

it('rolls back binding, evidence and outbox together and keeps manual/validated idempotency distinct', () => {
  const work = fixture()
  configRaw.exec('CREATE TRIGGER reject_outbox BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'fixture failure\'); END;')
  expect(() => requestValidatedActivation(config, bio, work.input, work.build)).toThrow('fixture failure')
  expect(work.profiles.binding('left').generation).toBe(0)
  expect(config.select().from(configSchema.biometricActivationEvents).all()).toEqual([])
  configRaw.exec('DROP TRIGGER reject_outbox')
  requestValidatedActivation(config, bio, work.input, work.build)
  expect(() => requestValidatedActivation(config, bio, { ...work.input, boundary: 'immediate' }, work.build)).toThrow('idempotency')
  expect(() => requestManualActivation(config, { side: 'left', action: 'reset', revisionId: null, expectedGeneration: 1,
    expectedResolvedHash: configHash(defaultConfig), boundary: 'immediate', requester: 'fixture', idempotencyKey: work.input.idempotencyKey, allowUnvalidated: true })).toThrow('idempotency')
})

it('resolves build authority lazily and retries after artifact release without probing', async () => {
  const work = fixture()
  const resolve = vi.fn(async () => work.build)
  const event = await requestValidatedActivationWithBuild(config, bio, work.input, resolve, now)
  expect(resolve).toHaveBeenCalledTimes(1)
  work.jobs.releaseResult(work.input.evaluationId, work.input.expectedReportHash)
  work.datasets.release(work.dataset.id)
  resolve.mockRejectedValue(new Error('Build no longer installed'))
  expect(await requestValidatedActivationWithBuild(config, bio, work.input, resolve, now + 1)).toEqual(event)
  expect(resolve).toHaveBeenCalledTimes(1)
  await expect(requestValidatedActivationWithBuild(config, bio, { ...work.input, expectedReportHash: '0'.repeat(64) }, resolve))
    .rejects.toThrow('idempotency key changed')
  expect(resolve).toHaveBeenCalledTimes(1)
})

it('coalesces identical activation intents that race across asynchronous build resolution', async () => {
  const work = fixture()
  let finish!: (build: typeof work.build) => void
  const pending = new Promise<typeof work.build>((resolve) => {
    finish = resolve
  })
  const first = requestValidatedActivationWithBuild(config, bio, work.input, () => pending, now)
  const second = await requestValidatedActivationWithBuild(config, bio, work.input, async () => work.build, now)
  work.jobs.releaseResult(work.input.evaluationId, work.input.expectedReportHash)
  finish(work.build)
  expect(await first).toEqual(second)
  expect(config.select().from(configSchema.biometricActivationEvents).all()).toHaveLength(1)
  expect(config.select().from(configSchema.biometricConfigOutbox).all()).toHaveLength(1)
})

it('leaves activation state unchanged when build resolution fails', async () => {
  const work = fixture()
  await expect(requestValidatedActivationWithBuild(config, bio, work.input, async () => {
    throw new Error('Worker missing')
  }))
    .rejects.toThrow('Worker missing')
  expect(work.profiles.binding('left').generation).toBe(0)
  expect(config.select().from(configSchema.biometricActivationEvents).all()).toEqual([])
})

it('reviews qualified evidence without writing intent and still revalidates after review', async () => {
  const work = fixture()
  const reviewInput = validatedActivationReviewSchema.strip().parse(work.input)
  expect(await reviewValidatedActivation(config, bio, reviewInput, async () => work.build)).toEqual({ eligible: true })
  expect(work.profiles.binding('left').generation).toBe(0)
  expect(config.select().from(configSchema.biometricActivationEvents).all()).toEqual([])
  expect(config.select().from(configSchema.biometricConfigOutbox).all()).toEqual([])
  work.jobs.releaseResult(work.input.evaluationId, work.input.expectedReportHash)
  await expect(requestValidatedActivationWithBuild(config, bio, work.input, async () => work.build)).rejects.toThrow()
  await expect(reviewValidatedActivation(config, bio, reviewInput, async () => work.build)).rejects.toThrow()
  expect(work.profiles.binding('left').generation).toBe(0)
})
