// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { performCoordinatorTask } from '../coordinator-tasks'

const mocks = vi.hoisted(() => ({ task: vi.fn(), open: vi.fn(), close: vi.fn(), pragma: vi.fn(), db: {} }))
vi.mock('../coordinator-tasks', () => ({ performCoordinatorTask: mocks.task }))
vi.mock('better-sqlite3', () => ({ default: class {
  constructor(...args: unknown[]) { mocks.open(...args) }
  close = mocks.close
  pragma = mocks.pragma
} }))
vi.mock('drizzle-orm/better-sqlite3', () => ({ drizzle: () => mocks.db }))
type Options = Parameters<typeof performCoordinatorTask>[2]
let listeners: Record<string, (...args: unknown[]) => unknown>
let sent: Array<Record<string, unknown>>
let disconnect: ReturnType<typeof vi.fn>
let kill: ReturnType<typeof vi.fn>
let exit: ReturnType<typeof vi.fn>
async function start(budget = 'null') {
  const original = process
  disconnect = vi.fn(() => listeners.disconnect?.())
  kill = vi.fn()
  exit = vi.fn()
  vi.stubGlobal('process', Object.assign(Object.create(original), {
    argv: ['node', 'coordinator', '/owned/biometrics.db', '/owned/worker.cjs', 'null', budget],
    on: (event: string, listener: (...args: unknown[]) => unknown) => { listeners[event] = listener },
    send: (message: Record<string, unknown>, callback?: () => void) => {
      sent.push(message)
      callback?.()
    },
    disconnect, kill, exit,
  }))
  await import('../coordinator-entry')
}
const message = (value: unknown) => listeners.message(value)
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.task.mockReset().mockResolvedValue({ ok: true })
  mocks.open.mockReset()
  listeners = {}
  sent = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('runs once, closes its database, and disconnects without killing completed work', async () => {
  await start()
  await message(null)
  await message({ type: 'unexpected' })
  await message({ type: 'run', task: { type: 'collectArtifacts' } })
  await message({ type: 'run', task: { type: 'execute' } })
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('/owned/biometrics.db', { fileMustExist: true, timeout: 1000 })
  expect(mocks.pragma).toHaveBeenCalledWith('foreign_keys = ON')
  expect(mocks.task).toHaveBeenCalledOnce()
  expect(mocks.task.mock.calls[0][2]).toMatchObject({ workerPath: '/owned/worker.cjs', rawLocation: undefined, replayBudget: undefined })
  expect(sent).toEqual([{ type: 'result', result: { ok: true } }])
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
  expect(exit).not.toHaveBeenCalled()
})

it.each([['valid', true], ['malformed', false], ['timeout', false]] as const)('correlates admission and fails closed for %s receipts', async (kind, allowed) => {
  vi.useFakeTimers()
  let options!: Options
  mocks.task.mockImplementation(async (_db, _task, received: Options) => {
    options = received
    expect(options.admissionReceipt?.()).toBeNull()
    return { admitted: await options.admit() }
  })
  await start()
  const running = message({ type: 'run', task: {} })
  expect(sent).toEqual([{ type: 'admission', sequence: 1 }])
  await message({ type: 'admission', sequence: 99, allowed: true })
  expect(options.admissionReceipt?.()).toBeNull()
  if (kind === 'timeout') await vi.advanceTimersByTimeAsync(2000)
  else await message({ type: 'admission', sequence: 1, allowed: kind === 'valid' ? true : 'yes', sample: null })
  await running
  expect(sent.at(-1)).toEqual({ type: 'result', result: { admitted: allowed } })
  expect(options.admissionReceipt?.()).toEqual({ allowed, sample: null })
  expect(vi.getTimerCount()).toBe(0)
})

it('propagates cancellation and kills its owned group on premature supervisor disconnect', async () => {
  await start()
  await message({ type: 'cancel' })
  mocks.task.mockImplementation(async (_db, _task, options: Options) => {
    expect(options.signal.aborted).toBe(true)
    listeners.disconnect()
    return null
  })
  await message({ type: 'run', task: {} })
  if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-process.pid, 'SIGKILL')
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
})

it.each([
  ['known', 'INVALID_INPUT', 'x'.repeat(1000)],
  ['unexpected', 'COORDINATOR_FAILED', 'Biometrics coordinator failed'],
])('bounds known error text and suppresses unexpected exports', async (error, code, text) => {
  await start()
  const { ReferenceInputError } = await import('../../references/time')
  mocks.task.mockRejectedValue(error === 'known' ? new ReferenceInputError('INVALID_INPUT', 'x'.repeat(1200)) : new Error('private source export'))
  await message({ type: 'run', task: {} })
  expect(sent).toEqual([{ type: 'error', code, message: text }])
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(exit).not.toHaveBeenCalled()
})

it('rejects oversized results without sending their contents', async () => {
  mocks.task.mockResolvedValue({ private: 'x'.repeat(17 * 1024 * 1024) })
  await start()
  await message({ type: 'run', task: {} })
  expect(sent).toEqual([{ type: 'error', code: 'COORDINATOR_FAILED', message: 'Biometrics coordinator failed' }])
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('validates execution limits before opening storage', async () => {
  await start('{"jobWallMs":-1}')
  await message({ type: 'run', task: {} })
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.task).not.toHaveBeenCalled()
  expect(sent[0]).toMatchObject({ type: 'error', code: 'COORDINATOR_FAILED' })
})

it('reports database-open failure without attempting work or leaking details', async () => {
  mocks.open.mockImplementation(() => {
    throw new Error('/private/path')
  })
  await start()
  await message({ type: 'run', task: {} })
  expect(mocks.task).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(sent).toEqual([{ type: 'error', code: 'COORDINATOR_FAILED', message: 'Biometrics coordinator failed' }])
})
