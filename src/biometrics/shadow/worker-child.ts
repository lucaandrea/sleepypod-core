import type { ShadowPartialReceipt } from './receipt'
import { shadowChildBudgetsSchema as budgetsSchema } from './execution-policy'
import { confirmShadowProcessCleanup } from './process-cleanup'
import { ShadowCleanupError } from './cleanup-error'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { configHash } from '../algorithms/canonical'
import { validateConfig } from '../algorithms/registry'
import { sampleProcessGroupRss } from '../backtest/process-group-memory'
import { ShadowWorkerProtocol, type shadowWorkerOutputSchema } from './worker-protocol'

const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const initSchema = z.object({ schema: z.literal('biometric-shadow-worker-v1'),
  runId: z.string().uuid(), attemptId: z.string().uuid(), side: z.enum(['left', 'right']),
  startMs: integer, endMs: integer, configs: z.object({ left: z.unknown(), right: z.unknown() }).strict(),
  configHashes: z.object({ left: hash, right: hash }).strict(), maximumRecords: integer,
  maximumOutputs: integer, maximumCpuMs: integer, maximumInputBytes: integer, maximumOutputBytes: integer,
}).strict()
export type ShadowChildBudgets = z.infer<typeof budgetsSchema>
type Output = z.infer<typeof shadowWorkerOutputSchema>
type Health = Extract<ReturnType<ShadowWorkerProtocol['accept']>, { type: 'finished' }>['health']
const LINE_BYTES = 128 * 1024

/** Trusted host paths and shipped code only. One frame in flight; the source
 * must itself bound buffering. Callers fence every output through the store.
 * This supervisor never opens a database, source, network or hardware handle. */
export async function runShadowChild(location: { pythonPath: string, modulesPath: string }, rawInit: unknown,
  frames: AsyncIterable<unknown>, onOutput: (output: Output) => void | Promise<void>,
  options: { budgets: ShadowChildBudgets, signal?: AbortSignal, onResources?: (receipt: ShadowPartialReceipt) => void }) {
  const init = initSchema.parse(structuredClone(rawInit))
  const budgets = budgetsSchema.parse(options.budgets)
  for (const side of ['left', 'right'] as const) {
    validateConfig(init.configs[side])
    if (configHash(init.configs[side]) !== init.configHashes[side]) throw new Error('Shadow configuration identity mismatch')
  }
  const protocol = new ShadowWorkerProtocol({ runId: init.runId, attemptId: init.attemptId, side: init.side,
    startMs: init.startMs, endMs: init.endMs, configHashes: init.configHashes,
    maximumRecords: init.maximumRecords, maximumOutputs: init.maximumOutputs, maximumCpuMs: init.maximumCpuMs })
  if (options.signal?.aborted) throw new Error('Shadow worker cancelled')
  const iterator = frames[Symbol.asyncIterator]()
  const child = spawn(location.pythonPath, ['-B', '-m', 'common.biometrics.shadow_process',
    '--parent-pid', String(process.pid), '--wall-ms', String(budgets.wallMs), '--cpu-seconds', String(budgets.cpuSeconds), '--address-space-bytes', String(budgets.addressSpaceBytes)], {
    detached: true, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC',
      OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
  })
  let lastHealth: Health | null = null
  let cleanupUnconfirmed = false
  let failure: Error | undefined, closed = false, terminal = false, stopping = false
  let inputBytes = 0, outputBytes = 0, diagnosticBytes = 0, peakRssBytes = 0, rssSamples = 0
  let lastRssAt = performance.now(), maximumObservationGapMs = 0
  let pending = Buffer.alloc(0)
  let reply: { type: Parameters<ShadowWorkerProtocol['accept']>[1], resolve: (value: ReturnType<ShadowWorkerProtocol['accept']>) => void } | undefined
  let rejectFailure!: (error: Error) => void
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
  })
  // A source/sink can be awaiting its own I/O when the process fails.
  void failed.catch(() => {})
  const fail = (message: string) => {
    if (!failure) {
      failure = new Error(message)
      rejectFailure(failure)
    }
  }
  const abort = () => fail('Shadow worker cancelled')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const wall = setTimeout(() => fail('Shadow worker wall deadline exceeded'), budgets.wallMs)
  const exited = new Promise<void>((resolve) => {
    child.once('close', (code) => {
      closed = true
      if (!stopping && (code !== 0 || !terminal || pending.length)) fail('Shadow worker failed or returned an incomplete result')
      resolve()
    })
  })
  child.on('error', () => fail('Shadow worker could not start'))
  child.stdin.on('error', () => fail('Shadow worker input pipe closed'))
  child.stdout.on('error', () => fail('Shadow worker output pipe failed'))
  child.stderr.on('error', () => fail('Shadow worker diagnostic pipe failed'))
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.length
    if (diagnosticBytes > 16384) fail('Shadow diagnostics exceed byte quota')
  })
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure) return
    outputBytes += chunk.length
    if (outputBytes > init.maximumOutputBytes) return fail('Shadow output exceeds byte quota')
    // Only one reply is permitted per command; never queue unsolicited output.
    const newline = chunk.indexOf(10)
    if (pending.length + (newline < 0 ? chunk.length : newline + 1) > LINE_BYTES) return fail('Shadow response line exceeds byte quota')
    pending = Buffer.concat([pending, chunk])
    const end = pending.indexOf(10)
    if (end < 0) return
    if (!reply || end !== pending.length - 1) return fail('Shadow worker emitted unsolicited output')
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end))
      const response = protocol.accept(JSON.parse(line), reply.type)
      if ('health' in response) lastHealth = structuredClone(response.health)
      const acknowledge = reply.resolve
      reply = undefined
      pending = Buffer.alloc(0)
      if (response.type === 'finished') terminal = true
      acknowledge(response)
    }
    catch { fail('Shadow worker emitted an invalid response') }
  })
  async function bounded<T>(operation: Promise<T>, ms: number, reason: string): Promise<T> {
    const timer = setTimeout(() => fail(reason), ms)
    try {
      return await Promise.race([operation, failed])
    }
    finally { clearTimeout(timer) }
  }
  let monitoring = false
  const sample = async () => {
    if (monitoring || closed || failure) return
    monitoring = true
    try {
      const rss = await bounded(Promise.race([sampleProcessGroupRss(child.pid ?? 0), exited.then(() => null)]), budgets.rssTimeoutMs, 'Shadow RSS observation timed out')
      if (closed || stopping || failure) return
      // procfs can lose a finished worker before Node delivers pipe closure.
      // Accept that disappearance only after a validated terminal response and
      // a bounded, successful close; the close handler still rejects bad exits.
      if (rss === null && terminal) {
        await bounded(exited, budgets.acknowledgmentMs, 'Shadow worker exit deadline exceeded')
        return
      }
      if (rss === null || !Number.isSafeInteger(rss) || rss <= 0) return fail('Shadow RSS observation unavailable')
      const observedAt = performance.now()
      maximumObservationGapMs = Math.max(maximumObservationGapMs, observedAt - lastRssAt)
      lastRssAt = observedAt
      rssSamples++
      peakRssBytes = Math.max(peakRssBytes, rss)
      if (rss > budgets.maximumRssBytes) fail('Shadow RSS quota exceeded')
    }
    catch {
      if (!closed && !stopping) fail('Shadow RSS observation unavailable')
    }
    finally { monitoring = false }
  }
  const memoryTimer = setInterval(() => {
    void sample()
  }, budgets.rssIntervalMs)
  child.once('spawn', () => {
    void sample()
  })
  async function request(message: unknown, type: Parameters<ShadowWorkerProtocol['accept']>[1]) {
    if (failure) throw failure
    if (closed || terminal || reply) throw new Error('Shadow worker is not accepting commands')
    const line = JSON.stringify(message) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > LINE_BYTES || inputBytes + bytes > init.maximumInputBytes) throw new Error('Shadow input exceeds byte quota')
    inputBytes += bytes
    const response = new Promise<ReturnType<ShadowWorkerProtocol['accept']>>((resolve) => {
      reply = { type, resolve }
    })
    child.stdin.write(line)
    return bounded(response, budgets.acknowledgmentMs, 'Shadow acknowledgment deadline exceeded')
  }
  let result: { health: Health, inputBytes: number, outputBytes: number, peakObservedRssBytes: number, rssSamples: number, maximumObservationGapMs: number, budgets: ShadowChildBudgets, memoryScope: 'sum_rss_of_shadow_process_group', exactKernelPeak: false } | undefined
  try {
    await request(init, 'ready')
    let records = 0
    while (true) {
      const next = await bounded(Promise.resolve().then(() => iterator.next()), budgets.idleMs, 'Shadow source idle deadline exceeded')
      if (next.done) break
      if (records >= init.maximumRecords) throw new Error('Shadow record quota exceeded')
      const frame = z.object({ type: z.literal('frame'), sequence: z.literal(records) }).passthrough().parse(next.value)
      const response = await request(frame, 'frame_result')
      if (response.type !== 'frame_result') throw new Error('Shadow frame acknowledgment missing')
      for (const output of response.outputs) await Promise.race([Promise.resolve().then(() => onOutput(output)), failed])
      records++
    }
    const response = await request({ type: 'finish' }, 'finished')
    if (response.type !== 'finished') throw new Error('Shadow completion missing')
    for (const output of response.outputs) await Promise.race([Promise.resolve().then(() => onOutput(output)), failed])
    child.stdin.end()
    await bounded(exited, budgets.acknowledgmentMs, 'Shadow worker exit deadline exceeded')
    if (!rssSamples) throw new Error('Shadow worker has no RSS observations')
    if (failure) throw failure
    result = { health: response.health, inputBytes, outputBytes, peakObservedRssBytes: peakRssBytes, rssSamples, maximumObservationGapMs: Math.max(maximumObservationGapMs, performance.now() - lastRssAt),
      budgets, memoryScope: 'sum_rss_of_shadow_process_group', exactKernelPeak: false }
  }
  catch (error) {
    fail(error instanceof Error ? error.message : 'Shadow source or sink failed')
  }
  finally {
    stopping = true
    clearTimeout(wall)
    clearInterval(memoryTimer)
    options.signal?.removeEventListener('abort', abort)
    // Terminate the entire detached group, including a child retaining pipes.
    // SIGKILL is deliberate: no canonical state exists in this worker to flush.
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupUnconfirmed = true
      }
    }
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    // Iterator cleanup may itself be stalled; never let it keep a worker alive.
    if (iterator.return) void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
    if (!await confirmShadowProcessCleanup(child.pid, () => closed)) cleanupUnconfirmed = true
  }
  try {
    options.onResources?.({ kind: 'partial_supervisor_observation', health: lastHealth,
      inputBytes, outputBytes, diagnosticBytes, peakObservedRssBytes: rssSamples ? peakRssBytes : null, rssSamples,
      maximumObservationGapMs: Math.max(maximumObservationGapMs, performance.now() - lastRssAt), budgets,
      cleanupConfirmed: !cleanupUnconfirmed, memoryScope: 'sum_rss_of_shadow_process_group', exactKernelPeak: false })
  }
  catch (error) { fail(error instanceof Error ? error.message : 'Shadow resource observation failed') }
  if (cleanupUnconfirmed) throw new ShadowCleanupError(failure)
  if (failure) throw failure
  if (!result) throw new Error('Shadow completion missing')
  return result
}
