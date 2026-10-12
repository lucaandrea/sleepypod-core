import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../algorithms/canonical'
import { manifestHash, validateConfig } from '../algorithms/registry'
import { ReferenceInputError } from '../references/time'
import { DatasetStore } from './datasets'

const jobs = schema.biometricBacktestJobs
const experiments = schema.biometricExperiments
const results = schema.biometricBacktestResults
const exposure = schema.biometricHoldoutAccesses
const manifestSchema = z.object({ splitProtocol: z.object({ assignments: z.array(z.object({ split: z.string(), startMs: z.number(), endMs: z.number() })) }) })
const key = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const experimentProtocolSchema = z.object({
  version: z.literal('descriptive-evaluation-v1'),
  mode: z.enum(['comparison', 'stage_replay']),
  // Explicit approximation, never represented as measured sensor calibration.
  assumedStageCalibrationQuality: z.number().min(0).max(1),
  pointToleranceMs: z.number().int().min(0).max(300000),
  clockOffsetMs: z.number().int().min(-3600000).max(3600000),
}).strict()
export const enqueueBacktestSchema = z.object({
  experimentId: z.string().uuid(), idempotencyKey: key,
  split: z.enum(['tuning', 'validation', 'holdout']),
  configs: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']), revisionId: z.string().uuid().nullable(),
    manifestHash: hash, resolvedHash: hash, resolved: z.unknown() }).strict()).min(1).max(3),
}).strict()
const progressSchema = z.object({ phase: z.enum(['queued', 'loading', 'evaluating', 'reporting', 'complete']),
  completedNights: z.number().int().min(0).max(60), totalNights: z.number().int().min(0).max(60) }).strict()
const leaseSchema = z.object({ id: z.string().uuid(), owner: key, token: z.number().int().positive() }).strict()
export type JobLease = z.infer<typeof leaseSchema>

/** Leases fence every publication; all expensive work happens outside SQLite. */
export class BacktestJobStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>, private readonly now = Date.now) {}

  createExperiment(datasetId: string, rawProtocol: z.input<typeof experimentProtocolSchema>) {
    const protocol = experimentProtocolSchema.parse(rawProtocol)
    const dataset = new DatasetStore(this.db).read(datasetId)
    return this.db.transaction((tx) => {
      const total = tx.select({ count: sql<number>`count(*)` }).from(experiments).get()?.count ?? 0
      if (total >= 1000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Experiment history has reached its 1000-entry bound')
      return tx.insert(experiments).values({ id: randomUUID(), datasetId, side: dataset.side,
        protocol, protocolHash: configHash(protocol), createdAtMs: this.now() }).returning().get()
    }, { behavior: 'immediate' })
  }

  holdoutUseCount(datasetId: string) {
    const dataset = this.db.select({ side: schema.biometricDatasets.side, manifest: schema.biometricDatasets.manifest })
      .from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, datasetId)).get()
    if (!dataset) throw new ReferenceInputError('NOT_FOUND', 'Dataset unavailable')
    const windows = manifestSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === 'holdout')
    if (!windows.length) return 0
    return this.db.selectDistinct({ jobId: exposure.jobId }).from(exposure).where(and(eq(exposure.side, dataset.side),
      or(...windows.map(window => and(lt(exposure.startMs, window.endMs), gt(exposure.endMs, window.startMs)))),
    )).all().length
  }

  enqueue(raw: z.input<typeof enqueueBacktestSchema>) {
    const input = enqueueBacktestSchema.parse(raw)
    if (new Set(input.configs.map(config => config.label)).size !== input.configs.length) throw new ReferenceInputError('INVALID_CONFIG', 'Baseline labels must be unique')
    for (const config of input.configs) {
      const resolved = validateConfig(config.resolved)
      if (config.manifestHash !== manifestHash || configHash(resolved) !== config.resolvedHash) throw new ReferenceInputError('INVALID_CONFIG', 'Resolved config or engine hash does not match this build')
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new ReferenceInputError('RESOURCE_LIMIT', 'Backtest configuration snapshot exceeds 64 KiB')
    const requestHash = configHash(input)
    return this.db.transaction((tx) => {
      const existing = tx.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey)).get()
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Backtest idempotency key changed')
        return existing
      }
      const total = tx.select({ count: sql<number>`count(*)` }).from(jobs).get()?.count ?? 0
      if (total >= 1000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Job history has reached its 1000-entry bound')
      const experiment = tx.select().from(experiments).where(eq(experiments.id, input.experimentId)).get()
      if (!experiment) throw new ReferenceInputError('NOT_FOUND', 'Experiment not found')
      const dataset = tx.select({ contentHash: schema.biometricDatasets.contentHash, manifest: schema.biometricDatasets.manifest })
        .from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, experiment.datasetId)).get()
      if (!dataset) throw new ReferenceInputError('NOT_FOUND', 'Dataset unavailable')
      const manifest = manifestSchema.parse(dataset.manifest)
      const totalNights = manifest.splitProtocol.assignments.filter(group => group.split === input.split).length
      if (!totalNights) throw new ReferenceInputError('INSUFFICIENT_NIGHTS', 'The frozen dataset has no nights assigned to this split')
      let holdoutUse = this.holdoutUseCount(experiment.datasetId)
      if (input.split === 'holdout') {
        holdoutUse++
        tx.update(experiments).set({ holdoutAccesses: experiment.holdoutAccesses + 1 }).where(eq(experiments.id, experiment.id)).run()
      }
      const now = this.now()
      const job = tx.insert(jobs).values({ id: randomUUID(), experimentId: experiment.id, idempotencyKey: input.idempotencyKey, requestHash,
        input: { version: 'backtest-job-v1', ...input, datasetId: experiment.datasetId, datasetHash: dataset.contentHash,
          protocol: experiment.protocol, protocolHash: experiment.protocolHash, holdoutUse,
          evidence: input.split === 'holdout' && holdoutUse > 1 ? 'reused_holdout_is_validation' : 'descriptive_only' },
        state: 'queued', progress: { phase: 'queued', completedNights: 0, totalNights }, createdAtMs: now, updatedAtMs: now,
      }).returning().get()
      if (input.split === 'holdout') {
        for (const window of manifest.splitProtocol.assignments.filter(row => row.split === 'holdout')) {
          tx.insert(exposure).values({ id: randomUUID(), jobId: job.id, side: experiment.side, startMs: window.startMs, endMs: window.endMs, accessedAtMs: now }).run()
        }
      }
      return job
    }, { behavior: 'immediate' })
  }

  get(id: string) {
    const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get()
    if (!job) throw new ReferenceInputError('NOT_FOUND', 'Backtest job not found')
    return job
  }

  /** Recover expired attempts without granting stale owners publication rights. */
  recover() {
    const now = this.now()
    return this.db.transaction((tx) => {
      const expired = tx.select().from(jobs).where(and(inArray(jobs.state, ['running', 'cancel_requested']), lte(jobs.leaseExpiresAtMs, now))).all()
      for (const job of expired) {
        tx.update(jobs).set({ state: job.state === 'cancel_requested' ? 'cancelled' : job.attempt >= 3 ? 'failed' : 'interrupted',
          leaseOwner: null, leaseExpiresAtMs: null, error: job.state === 'cancel_requested' ? null : 'Worker lease expired', updatedAtMs: now,
        }).where(eq(jobs.id, job.id)).run()
      }
      return expired.length
    }, { behavior: 'immediate' })
  }

  claim(owner: string, leaseMs = 30000) {
    key.parse(owner)
    z.number().int().min(1000).max(120000).parse(leaseMs)
    this.recover()
    return this.db.transaction((tx) => {
      const now = this.now()
      const active = tx.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.state, ['running', 'cancel_requested']), gt(jobs.leaseExpiresAtMs, now))).get()
      if (active) return null // one background replay at a time across processes
      const job = tx.select().from(jobs).where(inArray(jobs.state, ['queued', 'interrupted'])).orderBy(asc(jobs.createdAtMs), asc(jobs.id)).get()
      if (!job) return null
      return tx.update(jobs).set({ state: 'running', leaseOwner: owner, leaseExpiresAtMs: now + leaseMs,
        heartbeatAtMs: now, fencingToken: job.fencingToken + 1, attempt: job.attempt + 1,
        progress: { ...progressSchema.parse(job.progress), phase: 'loading', completedNights: 0 }, error: null, updatedAtMs: now,
      }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  private owned(lease: JobLease) {
    leaseSchema.parse(lease)
    const job = this.get(lease.id)
    if (job.leaseOwner !== lease.owner || job.fencingToken !== lease.token || (job.leaseExpiresAtMs ?? 0) <= this.now()
      || !['running', 'cancel_requested'].includes(job.state)) throw new ReferenceInputError('STALE_LEASE', 'Worker lease is no longer authoritative')
    return job
  }

  heartbeat(lease: JobLease, rawProgress: z.input<typeof progressSchema>, leaseMs = 30000) {
    const progress = progressSchema.parse(rawProgress)
    z.number().int().min(1000).max(120000).parse(leaseMs)
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      const previous = progressSchema.parse(job.progress)
      if (progress.totalNights !== previous.totalNights || progress.completedNights < previous.completedNights || progress.completedNights > progress.totalNights) throw new ReferenceInputError('INVALID_PROGRESS', 'Progress must be monotonic within the frozen night count')
      const now = this.now()
      tx.update(jobs).set({ progress, heartbeatAtMs: now, leaseExpiresAtMs: now + leaseMs, updatedAtMs: now }).where(eq(jobs.id, job.id)).run()
      return { cancelRequested: job.state === 'cancel_requested' }
    }, { behavior: 'immediate' })
  }

  cancel(id: string) {
    return this.db.transaction((tx) => {
      const job = this.get(id)
      if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
      const now = this.now()
      return tx.update(jobs).set({ state: job.state === 'queued' || job.state === 'interrupted' ? 'cancelled' : 'cancel_requested',
        cancellationRequestedAtMs: job.cancellationRequestedAtMs ?? now, updatedAtMs: now }).where(eq(jobs.id, id)).returning().get()
    }, { behavior: 'immediate' })
  }

  acknowledgeCancellation(lease: JobLease) {
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      if (job.state !== 'cancel_requested') throw new ReferenceInputError('INVALID_STATE', 'Cancellation has not been requested')
      return tx.update(jobs).set({ state: 'cancelled', leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: this.now() }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  fail(lease: JobLease, message: string) {
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      return tx.update(jobs).set({ state: job.state === 'cancel_requested' ? 'cancelled' : 'failed',
        error: message.slice(0, 1000), leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: this.now() }).where(eq(jobs.id, job.id)).returning().get()
    }, { behavior: 'immediate' })
  }

  complete(lease: JobLease, report: unknown) {
    // Concrete evaluator schemas validate reports before calling this sink.
    const serialized = JSON.stringify(report)
    if (!serialized || Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new ReferenceInputError('RESOURCE_LIMIT', 'Backtest summary exceeds 2 MiB')
    const contentHash = configHash(report)
    return this.db.transaction((tx) => {
      const job = this.owned(lease)
      if (job.state !== 'running') throw new ReferenceInputError('INVALID_STATE', 'Cancelled work cannot publish a result')
      const retained = tx.select({ bytes: sql<number>`coalesce(sum(length(cast(${results.report} as blob))), 0)` }).from(results).get()?.bytes ?? 0
      if (retained + Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new ReferenceInputError('RESOURCE_LIMIT', 'Backtest summaries have reached their 64 MiB storage budget')
      const now = this.now()
      tx.insert(results).values({ jobId: job.id, fencingToken: lease.token, report, contentHash, completedAtMs: now }).run()
      const progress = progressSchema.parse(job.progress)
      tx.update(jobs).set({ state: 'succeeded', progress: { ...progress, phase: 'complete', completedNights: progress.totalNights },
        leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: now }).where(eq(jobs.id, job.id)).run()
      return { jobId: job.id, contentHash }
    }, { behavior: 'immediate' })
  }
}
