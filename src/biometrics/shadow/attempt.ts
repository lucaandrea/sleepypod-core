import type { ShadowPartialReceipt } from './receipt'
import type { ShadowExecutionPolicy } from './execution-policy'
import { isShadowCleanupError, ShadowCleanupError } from './cleanup-error'
import { z } from 'zod'
import { configHash, dataHash } from '../algorithms/canonical'
import { validateConfig } from '../algorithms/registry'
import type { ShadowStore } from './store'
import { type ShadowLease } from './store'
import { ShadowStreamJoin } from './stream-join'
import { shadowActiveReadingSchema } from './worker-sink'
import { runShadowChild } from './worker-child'

type Plan = ReturnType<ShadowStore['get']>['plan']
export interface ShadowSources {
  frames: AsyncIterable<unknown>
  /** Poll committed active observations before sealing join timestamps. */
  flush?(): void
  /** Unsubscribe both streams synchronously, including on failed startup. */
  close(): void
}
export interface ShadowAttemptHost {
  location: { pythonPath: string, modulesPath: string }
  configs: { left: unknown, right: unknown }
  /** Trusted synchronous check of installed qualification/build, active binding,
   * resource admission and source health. Rechecked throughout the attempt. */
  admit(plan: Plan): void
  /** Must register bounded source adapters; the frame iterator is stopped at
   * collection end while active readings may arrive during the drain window. */
  openSources(input: { execution: ShadowExecutionPolicy, signal: AbortSignal, collectionEndsAtMs: number, fail: () => void, active: (reading: unknown) => void }): ShadowSources
}

/** Execute one fenced attempt. A restart is a new claim and fresh processor;
 * historical pending frames are never synthesized. The host owns crash recovery
 * and must terminate any orphan process before admitting a replacement. */
export async function runShadowAttempt(store: ShadowStore, runId: string, host: ShadowAttemptHost, signal?: AbortSignal) {
  const plan = store.get(runId).plan
  if (!plan.joining || !plan.execution) throw new Error('Shadow attempt requires frozen join and execution policies')
  const execution = structuredClone(plan.execution)
  const joining = plan.joining
  z.number().int().min(1000).max(3600000).parse(execution.leaseMs)
  z.number().int().positive().max(Math.min(1000, Math.floor(execution.leaseMs / 3), plan.monitoring.heartbeatStaleMs)).parse(execution.heartbeatMs)
  const configs = structuredClone(host.configs)
  const configHashes = { left: configHash(validateConfig(configs.left)), right: configHash(validateConfig(configs.right)) }
  if (configHashes[plan.side] !== plan.candidateConfigHash || dataHash(configHashes) !== dataHash(execution.configHashes)) throw new Error('Shadow candidate differs from frozen plan')
  if (signal?.aborted) throw new Error('Shadow attempt cancelled before claim')
  const admit = (frozen: Plan) => {
    const result: unknown = host.admit(structuredClone(frozen))
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {})
      throw new Error('Shadow admission must complete synchronously')
    }
  }
  const lease: ShadowLease = store.claim(runId, execution.leaseMs, admit)
  const controller = new AbortController()
  let sources: ShadowSources | undefined, worker: ReturnType<typeof runShadowChild> | undefined
  let failure: Error | undefined, terminalState: 'failed' | 'stopped' = 'failed', accepting = true
  let rejectFailure!: (error: Error) => void
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
  })
  void failed.catch(() => {})
  const stop = (reason: string, state: 'failed' | 'stopped' = 'failed') => {
    if (failure) return
    failure = new Error(reason)
    terminalState = state
    accepting = false
    controller.abort()
    rejectFailure(failure)
  }
  const abort = () => stop('shadow_cancelled', 'stopped')
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let endCollection!: () => void, endDrain!: () => void
  const collectionEnded = new Promise<void>((resolve) => {
    endCollection = resolve
  })
  const drained = new Promise<void>((resolve) => {
    endDrain = resolve
  })
  const collectionTimer = setTimeout(() => endCollection(), Math.max(0, plan.endMs - Date.now()))
  const drainTimer = setTimeout(() => endDrain(), Math.max(0, plan.endMs + joining.maximumLatenessMs - Date.now()))
  // Stop before the store's exclusive lease deadline so failure can be fenced.
  const deadline = setTimeout(() => stop('shadow_drain_deadline'), Math.max(0, plan.endMs + joining.drainGraceMs - Date.now() - 1))
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let resources: ShadowPartialReceipt | undefined
  const recordResources = (cause: unknown) => {
    try {
      if (resources) store.recordPartialReceipt(lease, resources)
    }
    catch (error) {
      const combined = new AggregateError([cause, error], 'Shadow partial resource evidence could not be stored')
      if (isShadowCleanupError(cause)) throw new ShadowCleanupError(combined)
      throw combined
    }
  }
  let receipt: Awaited<ReturnType<typeof runShadowChild>> | undefined
  try {
    const join = new ShadowStreamJoin(store, lease)
    const check = () => {
      if (failure) throw failure
      admit(plan)
      store.renew(lease, execution.leaseMs)
    }
    const advance = () => {
      const flushed: unknown = sources?.flush?.()
      if (flushed !== undefined) {
        void Promise.resolve(flushed).catch(() => {})
        throw new Error('Shadow source flush must complete synchronously')
      }
      if (failure) throw failure
      if (join.advance(Date.now()).stopped) stop('storage_quota', 'stopped')
    }
    heartbeat = setInterval(() => {
      try {
        check()
        advance()
      }
      catch { stop('shadow_admission_or_lease_lost') }
    }, execution.heartbeatMs)
    sources = host.openSources({ execution: structuredClone(execution), signal: controller.signal, collectionEndsAtMs: plan.endMs,
      fail: () => {
        if (accepting) stop('shadow_source_failed')
      },
      active: (reading) => {
        if (!accepting) return
        try {
          check()
          const active = shadowActiveReadingSchema.parse(reading)
          if (active.timestampMs > Date.now()) throw new Error('shadow_future_active_reading')
          join.active(active)
        }
        catch { stop('shadow_active_stream_failed') }
      } })
    const source = sources.frames[Symbol.asyncIterator]()
    async function* frames() {
      let sequence = 0
      try {
        while (Date.now() < plan.endMs) {
          const next = await Promise.race([Promise.resolve().then(() => source.next()), collectionEnded.then(() => ({ done: true as const, value: undefined })), failed])
          if (next.done) {
            if (Date.now() < plan.endMs) throw new Error('shadow_source_ended_early')
            break
          }
          if (Date.now() >= plan.endMs) break
          check()
          const frame = z.object({ type: z.literal('frame'), observedAtMs: z.number().int().min(plan.startMs).max(plan.endMs - 1) }).passthrough().parse(next.value)
          if (frame.observedAtMs > Date.now()) throw new Error('shadow_future_arrival')
          yield { ...frame, sequence: sequence++ }
        }
      }
      finally {
        if (source.return) void Promise.resolve().then(() => source.return?.()).catch(() => {})
      }
    }
    worker = runShadowChild(host.location, { schema: 'biometric-shadow-worker-v1', ...lease, runId,
      configs, configHashes, side: plan.side, startMs: plan.startMs, endMs: plan.endMs,
      maximumRecords: execution.maximumRecords, maximumOutputs: execution.maximumOutputs, maximumCpuMs: execution.maximumCpuMs,
      maximumInputBytes: execution.maximumInputBytes, maximumOutputBytes: execution.maximumOutputBytes }, frames(), (output) => {
      check()
      join.candidate(output)
    }, { budgets: structuredClone(execution.budgets), signal: controller.signal, onResources: (value) => { resources = value } })
    receipt = await Promise.race([worker, failed])
    await Promise.race([drained, failed])
    check()
    advance()
    if (failure) throw failure
    accepting = false
  }
  catch (error) {
    stop(error instanceof Error ? error.message.slice(0, 500) : 'shadow_attempt_failed')
  }
  finally {
    accepting = false
    controller.abort()
    clearInterval(heartbeat)
    clearTimeout(collectionTimer)
    clearTimeout(drainTimer)
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
    try {
      const result: unknown = sources?.close()
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {})
        stop('shadow_source_cleanup_must_be_synchronous')
      }
    }
    catch { stop('shadow_source_cleanup_failed') }
    // The subprocess supervisor bounds its own cleanup, including on abortion.
    if (worker) await worker.catch((error: unknown) => {
      if (isShadowCleanupError(error)) {
        failure = error
        terminalState = 'failed'
      }
    })
  }
  if (!failure) {
    try {
      admit(plan)
    }
    catch { stop('shadow_admission_changed_before_completion') }
  }
  if (failure) {
    try {
      store.finish(lease, terminalState, failure.message)
    }
    catch {
      // The supervisor has settled; cleanup may be unconfirmed. An expired attempt can be marked failed,
      // but this compare-and-set cannot touch a replacement or terminal run.
      try {
        store.failExpired(lease, failure.message)
      }
      catch { /* Storage failure remains observable through the rejected run. */ }
    }
    recordResources(failure)
    throw failure
  }
  try {
    if (!receipt) throw new Error('Shadow worker receipt missing')
    store.finish(lease, 'completed', 'observation_window_complete', receipt)
  }
  catch (error) {
    // A synchronous final read/cleanup can outlast the remaining lease even
    // when its admission check succeeds. Cleanup is complete; fence the failure.
    try {
      try {
        store.finish(lease, 'failed', 'shadow_completion_failed')
      }
      catch { store.failExpired(lease, 'shadow_completion_lease_lost') }
    }
    catch { /* Preserve the original completion error. */ }
    recordResources(error)
    throw error
  }
  return { lease, receipt, run: store.get(runId) }
}
