// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { BacktestHost } from '../host'
afterEach(() => vi.useRealTimers())
it('never overlaps attempts and awaits aborted execution before shutdown completes', async () => {
  vi.useFakeTimers()
  let release: (() => void) | undefined
  let observedSignal: AbortSignal | undefined
  const execute = vi.fn((signal: AbortSignal) => {
    observedSignal = signal
    return new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const host = new BacktestHost({ execute, collect: vi.fn() })
  host.start()
  await vi.advanceTimersByTimeAsync(0)
  host.start()
  await vi.advanceTimersByTimeAsync(60000)
  expect(execute).toHaveBeenCalledTimes(1)
  let finished = false
  const stopping = host.stop().then(() => {
    finished = true
  })
  expect(observedSignal?.aborted).toBe(true)
  await Promise.resolve()
  expect(finished).toBe(false)
  release?.()
  await stopping
  expect(finished).toBe(true)
  await vi.advanceTimersByTimeAsync(60000)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it('recovers from execution and cleanup errors without spinning or abandoning later work', async () => {
  vi.useFakeTimers()
  const execute = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({ state: 'idle' })
  const collect = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined)
  const onError = vi.fn()
  const host = new BacktestHost({ execute, collect, onError })
  host.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(onError.mock.calls).toEqual([['cleanup'], ['execution']])
  await vi.advanceTimersByTimeAsync(4999)
  expect(execute).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(collect).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1800000)
  expect(collect).toHaveBeenCalledTimes(2)
  await host.stop()
})
it('does not begin a job when shutdown arrives during cleanup', async () => {
  vi.useFakeTimers()
  let release: (() => void) | undefined
  const execute = vi.fn()
  const host = new BacktestHost({ execute, collect: () => new Promise<void>((resolve) => {
    release = resolve
  }) })
  host.start()
  const stopping = host.stop()
  release?.()
  await stopping
  expect(execute).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it('aborts the active cleanup on shutdown and waits for its acknowledgement', async () => {
  vi.useFakeTimers()
  const execute = vi.fn()
  let aborted = false
  const host = new BacktestHost({ execute, collect: signal => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      aborted = true
      resolve()
    }, { once: true })
  }) })
  host.start()
  await host.stop()
  expect(aborted).toBe(true)
  expect(execute).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
