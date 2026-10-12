import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type * as schema from '@/src/db/biometrics-schema'
import { DatasetStore } from './datasets'
import { BacktestJobStore } from './jobs'
import { backtestWorkSchema } from './evaluator'
import { executeWaveformInputs, verifyWaveformJobBuild } from './waveform-execution'
import type { RawInspectionLocation } from './raw-inspection-child'
import { workerBuildHash, runBacktestChild } from './child'

/** One leased attempt. Call only after the host's resource/ingest gate admits work. */
export async function executeNextBacktest(db: BetterSQLite3Database<typeof schema>, options: {
  owner: string
  workerPath: string
  rawLocation?: RawInspectionLocation
  signal?: AbortSignal
  timeoutMs?: number
  admit: () => Promise<boolean>
}) {
  if (options.signal?.aborted || !await options.admit() || options.signal?.aborted) return { state: 'deferred' as const }
  const jobs = new BacktestJobStore(db)
  const claimed = jobs.claim(options.owner)
  if (!claimed) return { state: 'idle' as const }
  const lease = { id: claimed.id, owner: options.owner, token: claimed.fencingToken }
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  let progress = z.object({ completedNights: z.number(), totalNights: z.number() }).parse(claimed.progress)
  let heartbeatFailure: unknown
  let resourceFailure = false
  let resourceCheck: Promise<void> | null = null
  const heartbeat = () => {
    try {
      const result = jobs.heartbeat(lease, { phase: 'evaluating', ...progress })
      if (result.cancelRequested) controller.abort()
    }
    catch (error) {
      heartbeatFailure = error
      controller.abort()
    }
  }
  const checkResources = async () => {
    try {
      if (await options.admit()) return
    }
    catch { /* Missing health evidence must stop background work. */ }
    resourceFailure = true
    controller.abort()
  }
  const timer = setInterval(() => {
    heartbeat()
    if (!resourceCheck && !controller.signal.aborted) {
      resourceCheck = checkResources().finally(() => {
        resourceCheck = null
      })
    }
  }, 5000)
  try {
    const input = z.object({ datasetId: z.string() }).parse(claimed.input)
    const retained = new DatasetStore(db).read(input.datasetId)
    const work = backtestWorkSchema.parse({ job: claimed.input, dataset: { manifest: retained.manifest, snapshot: retained.snapshot } })
    if (work.job.protocol.mode === 'signal_replay') {
      work.waveform = await executeWaveformInputs(db, work, { ...options, signal: controller.signal })
    }
    else if (await workerBuildHash(options.workerPath) !== work.job.evaluatorBuildHash) throw new Error('Evaluator bundle changed since enqueue')
    heartbeat()
    const report = await runBacktestChild(options.workerPath, work, { signal: controller.signal, timeoutMs: options.timeoutMs,
      onProgress: (completedNights, totalNights) => {
        if (totalNights !== progress.totalNights || completedNights < progress.completedNights || completedNights > totalNights) throw new Error('Invalid worker progress')
        progress = { completedNights, totalNights }
        heartbeat()
      },
    })
    if (work.job.protocol.mode === 'signal_replay') await verifyWaveformJobBuild(work, { ...options, signal: controller.signal })
    // Quiesce the periodic check before the final fresh check and publication.
    clearInterval(timer)
    await resourceCheck
    await checkResources()
    if (heartbeatFailure) throw heartbeatFailure
    const identity = z.object({ datasetHash: z.string(), protocolHash: z.string(), evaluatorBuildHash: z.string(), split: z.string(), nights: z.array(z.unknown()) }).parse(report)
    if (identity.evaluatorBuildHash !== work.job.evaluatorBuildHash || identity.datasetHash !== work.job.datasetHash || identity.protocolHash !== work.job.protocolHash || identity.split !== work.job.split
      || identity.nights.length !== progress.totalNights || progress.completedNights !== progress.totalNights) throw new Error('Worker report identity/progress mismatch')
    if (controller.signal.aborted) throw new Error('Replay cancelled')
    jobs.complete(lease, report)
    return { state: 'succeeded' as const, jobId: claimed.id }
  }
  catch {
    // Only the authoritative lease may update state. Expired work is recovered
    // by the next claimant; it must not overwrite a replacement's result.
    try {
      const latest = jobs.get(claimed.id)
      if (latest.state === 'cancel_requested') jobs.acknowledgeCancellation(lease)
      else if (options.signal?.aborted || resourceFailure) jobs.interrupt(lease, resourceFailure ? 'Resource admission withdrawn' : 'Worker host stopped')
      else jobs.fail(lease, 'Replay failed validation, resources, or execution')
    }
    catch { /* Lost lease: recovery owns the state transition. */ }
    return { state: 'stopped' as const, jobId: claimed.id }
  }
  finally {
    clearInterval(timer)
    await resourceCheck
    options.signal?.removeEventListener('abort', abort)
  }
}
