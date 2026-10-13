import { z } from 'zod'
import type { ShadowStore } from './store'

interface ShadowServiceOptions {
  execute: (runId: string, revisionId: string | null, signal: AbortSignal) => Promise<unknown>
  recover: (options: Parameters<ShadowStore['reconcileExpired']>[0]) => ReturnType<ShadowStore['reconcileExpired']>
  recoveryIntervalMs: number
  recoveryMaximumRuns: number
  onRecoveryError?: () => void
}

/** Owns local attempts and bounded maintenance. The store lease and worker flock
 * remain authoritative across processes. An aborted attempt keeps its slot until
 * execution has finished cleanup. This is not a durable scheduling queue. */
export class ShadowService {
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private cursor: string | undefined
  private active: { runId: string, controller: AbortController, done: Promise<unknown> } | null = null
  private readonly options: ShadowServiceOptions

  constructor(options: ShadowServiceOptions) {
    z.number().int().min(10).max(300000).parse(options.recoveryIntervalMs)
    z.number().int().min(1).max(100).parse(options.recoveryMaximumRuns)
    this.options = { ...options }
  }

  start() {
    if (this.stopped || this.timer) return
    this.reconcile()
  }

  private reconcile() {
    try {
      const result = this.options.recover({ maximumRuns: this.options.recoveryMaximumRuns,
        ...(this.cursor ? { afterId: this.cursor } : {}) })
      this.cursor = result.nextCursor ?? undefined
    }
    catch {
      try {
        this.options.onRecoveryError?.()
      }
      catch { /* Logging must not disable recovery. */ }
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.reconcile()
      }, this.options.recoveryIntervalMs)
      this.timer.unref()
    }
  }

  run(runId: string, revisionId: string | null) {
    z.string().uuid().parse(runId)
    z.string().uuid().nullable().parse(revisionId)
    if (this.stopped) throw new Error('Shadow service stopped')
    if (this.active) throw new Error('Shadow service busy')
    const controller = new AbortController()
    // Defer execution so even synchronous failure cannot leave a stale slot.
    const done = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Shadow attempt cancelled')
      return this.options.execute(runId, revisionId, controller.signal)
    }).finally(() => {
      if (this.active?.done === done) this.active = null
    })
    this.active = { runId, controller, done }
    return done
  }

  async cancel(runId: string) {
    z.string().uuid().parse(runId)
    const active = this.active
    if (!active || active.runId !== runId) return false
    active.controller.abort()
    await active.done.catch(() => {})
    return true
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const active = this.active
    active?.controller.abort()
    await active?.done.catch(() => {})
  }
}
