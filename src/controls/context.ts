import { AsyncLocalStorage } from 'node:async_hooks'

export interface ControlDispatchScope {
  issuedAt: number
  expiresAt: number
  monotonicDeadline: number
  now: () => number
  monotonicNow: () => number
  beforeDispatch: (at: number) => void
  dispatchCount: number
  deadlineRejected: boolean
  closed: boolean
}

const globals = globalThis as typeof globalThis & { __sp_controlScope?: AsyncLocalStorage<ControlDispatchScope> }
const storage = globals.__sp_controlScope ??= new AsyncLocalStorage<ControlDispatchScope>()

export class ControlDeadlineError extends Error {
  constructor() {
    super('Control request expired before dispatch')
    this.name = 'ControlDeadlineError'
  }
}

/** Recheck after queue waits, including a wall-clock rollback during the request. */
export function assertControlDeadline(): void {
  const scope = storage.getStore()
  if (!scope) return
  const now = scope.now()
  if (scope.closed || now < scope.issuedAt || now >= scope.expiresAt || scope.monotonicNow() >= scope.monotonicDeadline) {
    scope.deadlineRejected = true
    throw new ControlDeadlineError()
  }
}

/** Persist the dispatch barrier before a byte can leave this process. */
export function beforeControlWrite(): void {
  const scope = storage.getStore()
  if (!scope) return
  assertControlDeadline()
  scope.beforeDispatch(scope.now())
  scope.dispatchCount++
  // A contended SQLite commit can itself outlast the request's lifetime.
  assertControlDeadline()
}

export async function withinControlRequest<T>(scope: ControlDispatchScope, execute: () => Promise<T>): Promise<T> {
  return storage.run(scope, async () => {
    try {
      assertControlDeadline()
      return await execute()
    }
    finally {
      scope.closed = true
    }
  })
}

/** Long-lived schedulers must not inherit the request that first initializes them. */
export function outsideControlRequest<T>(execute: () => T): T {
  return storage.exit(execute)
}
