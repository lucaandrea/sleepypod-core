import type { HealthAdmission } from './job-operations'
import { randomUUID } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { coordinatorRequest } from './coordinator-service'

interface HostOptions {
  execute: (signal: AbortSignal) => Promise<unknown>
  collect: (signal: AbortSignal) => void | Promise<void>
  onError?: (phase: 'execution' | 'cleanup') => void
  intervalMs?: number
  clock?: () => number
}

/** One serialized host loop. The runner still owns the database lease, so
 * multiple processes cannot bypass fencing by each creating a local host. */
export class BacktestHost {
  private stopped = false
  private active: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller = new AbortController()
  private lastCollection = -Infinity
  private readonly clock: () => number
  constructor(private readonly options: HostOptions) {
    this.clock = options.clock ?? Date.now
    if (!Number.isSafeInteger(options.intervalMs ?? 5000) || (options.intervalMs ?? 5000) < 10) throw new Error('Invalid backtest host interval')
  }

  start() {
    if (!this.stopped && !this.active && !this.timer) this.tick()
  }

  private report(phase: 'execution' | 'cleanup') {
    try {
      this.options.onError?.(phase)
    }
    catch { /* Observability must not stop recovery. */ }
  }

  private tick() {
    if (this.stopped || this.active) return
    this.timer = null
    this.active = this.run().finally(() => {
      this.active = null
      if (!this.stopped) {
        this.timer = setTimeout(() => this.tick(), this.options.intervalMs ?? 5000)
        this.timer.unref()
      }
    })
  }

  private async run() {
    if (this.clock() - this.lastCollection >= 1800000) {
      this.lastCollection = this.clock()
      try {
        await this.options.collect(this.controller.signal)
      }
      catch {
        this.report('cleanup')
      }
    }
    if (this.stopped) return
    try {
      await this.options.execute(this.controller.signal)
    }
    catch {
      this.report('execution')
    }
  }

  /** Abort the child, then await its lease interruption before DB closure. */
  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.controller.abort()
    await this.active
  }
}

const shared = globalThis as typeof globalThis & { __biometricBacktestHost?: BacktestHost }
/** Admission is mandatory and supplied by the deployment's resource policy.
 * There is deliberately no permissive fallback for missing health evidence. */
export function startBacktestHost(db: BetterSQLite3Database<typeof schema>, admit: () => Promise<boolean>, healthAdmission?: HealthAdmission) {
  if (shared.__biometricBacktestHost) return shared.__biometricBacktestHost
  const owner = `core:${process.pid}:${randomUUID()}`
  const host = new BacktestHost({
    execute: signal => coordinatorRequest(db, { type: 'execute', owner }, { signal, admit, healthAdmission }),
    collect: signal => coordinatorRequest(db, { type: 'collectArtifacts' }, { signal, admit, healthAdmission }).then(() => {}),
    onError: phase => console.warn(`[biometrics] Backtest ${phase} failed; host will retry`),
  })
  shared.__biometricBacktestHost = host
  host.start()
  return host
}
export async function stopBacktestHost() {
  const host = shared.__biometricBacktestHost
  if (!host) return
  await host.stop()
  if (shared.__biometricBacktestHost === host) delete shared.__biometricBacktestHost
}
