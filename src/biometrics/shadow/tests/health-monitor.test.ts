// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startShadowHealthMonitor, openShadowHealthMonitor } from '../health-monitor'
import { collectAdmissionSample } from '../../backtest/admission'
import type * as Admission from '../../backtest/admission'
vi.mock('../../backtest/admission', async original => ({ ...await original<typeof Admission>(), collectAdmissionSample: vi.fn() }))
const now = 1700000000000
const policy = { qualificationId: 'test', minimumAvailableMemoryBytes: 100, minimumFreeDiskBytes: 100,
  maximumLoadPerCpu: 1, maximumEventLoopDelayMs: 100, maximumPiezoAgeMs: 1000, maximumTemperatureC: 70, maximumSampleAgeMs: 1000 }
const sample = () => ({ measuredAtMs: Date.now(), availableMemoryBytes: 1000, freeDiskBytes: 1000,
  loadPerCpu: 0.1, eventLoopDelayMs: 1, piezoReceivedAtMs: Date.now(), temperatureC: 40 })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})
it('refreshes real collector arguments and isolates published snapshots', async () => {
  vi.mocked(collectAdmissionSample).mockImplementation(async (directory, piezo) => {
    expect(directory).toBe('/trusted/data')
    expect(piezo()).toBe(Date.now() - 10)
    return sample()
  })
  const monitor = await openShadowHealthMonitor('/trusted/data', policy, () => Date.now() - 10)
  const first = monitor.read()
  expect(first).not.toBeNull()
  if (first) first.availableMemoryBytes = 0
  expect(monitor.read()?.availableMemoryBytes).toBe(1000)
  await vi.advanceTimersByTimeAsync(500)
  expect(collectAdmissionSample).toHaveBeenCalledTimes(2)
  expect(monitor.read()?.measuredAtMs).toBe(now + 500)
  monitor.close()
  expect(monitor.read()).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(collectAdmissionSample).toHaveBeenCalledTimes(2)
})
it('makes a stalled refresh terminal without overlapping I/O or accepting its late result', async () => {
  let resolve!: (value: ReturnType<typeof sample>) => void
  const collect = vi.fn().mockResolvedValueOnce(sample()).mockImplementationOnce(() => new Promise((done) => {
    resolve = done
  }))
  const monitor = await startShadowHealthMonitor(collect, policy)
  await vi.advanceTimersByTimeAsync(1000)
  expect(monitor.read()).toBeNull()
  resolve(sample())
  await vi.advanceTimersByTimeAsync(10000)
  expect(monitor.read()).toBeNull()
  expect(collect).toHaveBeenCalledTimes(2)
})
it('rejects initial timeout and cancellation without waiting for blocked collection', async () => {
  const pending = startShadowHealthMonitor(() => new Promise(() => {}), policy)
  const rejected = expect(pending).rejects.toThrow(/deadline/)
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  const abort = new AbortController()
  const task = startShadowHealthMonitor(() => new Promise(() => {}), policy, abort.signal)
  const cancelled = expect(task).rejects.toThrow(/closed/)
  abort.abort()
  await cancelled
})
it('denies stale or unhealthy evidence and clears previous health on failed refresh', async () => {
  const collect = vi.fn().mockResolvedValueOnce(sample()).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...sample(), temperatureC: 100 })
  const monitor = await startShadowHealthMonitor(collect, policy)
  vi.setSystemTime(now + 1001)
  expect(monitor.read()).toBeNull()
  await vi.advanceTimersByTimeAsync(500)
  expect(monitor.read()).toBeNull()
  await vi.advanceTimersByTimeAsync(500)
  expect(monitor.read()).toBeNull()
  monitor.close()
})
it('closes on collector rejection and observes late rejected promises after timeout', async () => {
  const monitor = await startShadowHealthMonitor(vi.fn().mockResolvedValueOnce(sample()).mockRejectedValueOnce(new Error('I/O failed')), policy)
  await vi.advanceTimersByTimeAsync(500)
  expect(monitor.read()).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  let reject!: (error: Error) => void
  const pending = startShadowHealthMonitor(() => new Promise((_resolve, fail) => {
    reject = fail
  }), policy)
  const rejected = expect(pending).rejects.toThrow(/deadline/)
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  reject(new Error('late failure'))
  await Promise.resolve()
})
it('does not collect after pre-abort and clears scheduled refresh on later abort', async () => {
  const pre = new AbortController(), collect = vi.fn().mockResolvedValue(sample())
  pre.abort()
  await expect(startShadowHealthMonitor(collect, policy, pre.signal)).rejects.toThrow(/closed/)
  expect(collect).not.toHaveBeenCalled()
  const abort = new AbortController()
  const monitor = await startShadowHealthMonitor(collect, policy, abort.signal)
  abort.abort()
  expect(monitor.read()).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(2000)
  expect(collect).toHaveBeenCalledTimes(1)
})
