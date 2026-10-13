// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { ShadowService } from '../service'

const runId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
function setup() {
  const execute = vi.fn<ConstructorParameters<typeof ShadowService>[0]['execute']>().mockResolvedValue('complete')
  const recover = vi.fn(() => ({ scanned: 0, recovered: [], nextCursor: null as string | null }))
  const onRecoveryError = vi.fn()
  return { execute, recover, onRecoveryError, service: new ShadowService({ execute, recover, onRecoveryError,
    recoveryIntervalMs: 100, recoveryMaximumRuns: 7 }) }
}
afterEach(() => vi.useRealTimers())

it('schedules saved pending identity while maintenance continues during worker cleanup', async () => {
  vi.useFakeTimers()
  const { execute, recover } = setup()
  const pending = vi.fn().mockReturnValueOnce({ run: { runId, revisionId: otherId }, nextCursor: runId })
    .mockReturnValue({ run: null, nextCursor: null })
  let release!: () => void
  execute.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const service = new ShadowService({ execute, recover, pending, recoveryIntervalMs: 100, recoveryMaximumRuns: 7 })
  service.start()
  await Promise.resolve()
  expect(execute).toHaveBeenCalledWith(runId, otherId, expect.any(AbortSignal))
  await vi.advanceTimersByTimeAsync(300)
  expect(recover).toHaveBeenCalledTimes(4)
  expect(pending).toHaveBeenCalledOnce()
  release()
  await vi.advanceTimersByTimeAsync(100)
  expect(pending).toHaveBeenLastCalledWith({ maximumRuns: 7, afterId: runId })
  await service.stop()
})

it('retries failed queue scans and observes scheduled execution errors', async () => {
  vi.useFakeTimers()
  const { execute, recover } = setup()
  const pending = vi.fn().mockImplementationOnce(() => {
    throw new Error('database busy')
  }).mockReturnValueOnce({ run: { runId, revisionId: null }, nextCursor: runId })
    .mockReturnValue({ run: null, nextCursor: null })
  const onExecutionError = vi.fn(() => {
    throw new Error('logging failed')
  })
  execute.mockRejectedValueOnce(new Error('admission refused'))
  const service = new ShadowService({ execute, recover, pending, onExecutionError, recoveryIntervalMs: 100, recoveryMaximumRuns: 7 })
  service.start()
  await vi.advanceTimersByTimeAsync(100)
  expect(pending.mock.calls.slice(0, 2)).toEqual([[{ maximumRuns: 7 }], [{ maximumRuns: 7 }]])
  expect(onExecutionError).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(100)
  expect(pending).toHaveBeenLastCalledWith({ maximumRuns: 7, afterId: runId })
  await service.stop()
})

it('advances bounded sweeps, retains the cursor on failure and stops maintenance', async () => {
  vi.useFakeTimers()
  const { service, recover, onRecoveryError } = setup()
  recover.mockReturnValueOnce({ scanned: 7, recovered: [], nextCursor: runId })
  service.start()
  service.start()
  expect(recover).toHaveBeenCalledTimes(1)
  recover.mockImplementationOnce(() => {
    throw new Error('busy')
  })
  onRecoveryError.mockImplementationOnce(() => {
    throw new Error('logger failed')
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(onRecoveryError).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(100)
  expect(recover.mock.calls.slice(1)).toEqual([[{ maximumRuns: 7, afterId: runId }], [{ maximumRuns: 7, afterId: runId }]])
  await vi.advanceTimersByTimeAsync(100)
  expect(recover).toHaveBeenLastCalledWith({ maximumRuns: 7 })
  await service.stop()
  service.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(recover).toHaveBeenCalledTimes(4)
})

it('retains the execution slot through cancellation and asynchronous cleanup', async () => {
  const { service, execute } = setup()
  let release!: () => void
  let signal!: AbortSignal
  execute.mockImplementation(async (_id, _revision, received) => {
    signal = received
    await new Promise<void>((resolve) => {
      release = resolve
    })
    throw new Error('cancelled after cleanup')
  })
  const run = service.run(runId, otherId)
  const failure = expect(run).rejects.toThrow('cancelled after cleanup')
  await Promise.resolve()
  expect(execute).toHaveBeenCalledWith(runId, otherId, signal)
  expect(await service.cancel(otherId)).toBe(false)
  expect(signal.aborted).toBe(false)
  let cancelled = false
  const cancellation = service.cancel(runId).then((result) => {
    cancelled = result
  })
  expect(signal.aborted).toBe(true)
  expect(() => service.run(otherId, null)).toThrow('busy')
  await Promise.resolve()
  expect(cancelled).toBe(false)
  release()
  await Promise.all([failure, cancellation])
  expect(cancelled).toBe(true)
  execute.mockResolvedValueOnce('next')
  expect(await service.run(otherId, null)).toBe('next')
  await service.stop()
})

it('shutdown aborts, waits for cleanup, rejects new work and is repeatable', async () => {
  const { service, execute } = setup()
  let release!: () => void
  execute.mockImplementation(async (_id, _revision, signal) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    expect(signal.aborted).toBe(true)
  })
  const run = service.run(runId, null)
  await Promise.resolve()
  let stopped = false
  const stop = service.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(() => service.run(otherId, null)).toThrow('stopped')
  release()
  await Promise.all([stop, run, service.stop()])
  expect(stopped).toBe(true)
})

it('cancels before starting a deferred worker and releases synchronous failures', async () => {
  const { service, execute } = setup()
  const run = service.run(runId, null)
  const failed = expect(run).rejects.toThrow('cancelled')
  await service.cancel(runId)
  await failed
  expect(execute).not.toHaveBeenCalled()
  execute.mockImplementationOnce(() => {
    throw new Error('startup failed')
  })
  await expect(service.run(runId, null)).rejects.toThrow('startup failed')
  expect(await service.run(otherId, null)).toBe('complete')
  await service.stop()
})

it('quarantines scheduling after unconfirmed cleanup while maintenance continues', async () => {
  vi.useFakeTimers()
  const { execute, recover } = setup()
  const pending = vi.fn(() => ({ run: { runId, revisionId: null }, nextCursor: runId }))
  let reject!: (error: Error) => void
  execute.mockImplementation(() => new Promise((_resolve, fail) => {
    reject = fail
  }))
  const service = new ShadowService({ execute, recover, pending, recoveryIntervalMs: 100, recoveryMaximumRuns: 7 })
  service.start()
  await Promise.resolve()
  const cancelled = service.cancel(runId)
  reject(Object.assign(new Error('shadow_worker_cleanup_unconfirmed'), { code: 'SHADOW_CLEANUP_UNCONFIRMED' }))
  expect(await cancelled).toBe(false)
  await vi.advanceTimersByTimeAsync(300)
  expect(pending).toHaveBeenCalledOnce()
  expect(recover).toHaveBeenCalledTimes(4)
  expect(() => service.run(otherId, null)).toThrow('cleanup unconfirmed')
  await service.stop()
})
