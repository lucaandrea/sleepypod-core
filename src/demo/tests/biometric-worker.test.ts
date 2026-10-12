// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runDemoEvaluation } from '../biometrics/run'
import { backtestFixture } from '@/src/biometrics/backtest/tests/fixtures/backtest'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
}
function current() {
  const instance = FakeWorker.instances.at(-1)
  if (!instance) throw new Error('Worker not created')
  return instance
}
beforeEach(() => vi.stubGlobal('Worker', FakeWorker))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('forwards progress and returns the worker report, terminating the completed worker', async () => {
  const input = backtestFixture(), report = evaluateBacktest(input), progress = vi.fn()
  const result = runDemoEvaluation(input, progress, new AbortController().signal)
  expect(current().postMessage).toHaveBeenCalledWith(input)
  current().onmessage?.({ data: { type: 'progress', completedNights: 1, totalNights: 1 } })
  expect(progress).toHaveBeenCalledWith(1, 1)
  current().onmessage?.({ data: { type: 'result', report } })
  expect(await result).toEqual(report)
  expect(current().terminate).toHaveBeenCalledTimes(1)
  current().onmessage?.({ data: { type: 'progress', completedNights: 2, totalNights: 2 } })
  expect(progress).toHaveBeenCalledTimes(1)
})
it('terminates cancelled work and ignores late completion', async () => {
  const controller = new AbortController()
  const result = runDemoEvaluation(backtestFixture(), vi.fn(), controller.signal)
  const rejection = expect(result).rejects.toThrow('cancelled')
  controller.abort()
  await rejection
  current().onmessage?.({ data: { type: 'result', report: {} } })
  expect(current().terminate).toHaveBeenCalledTimes(1)
})
it('bounds execution time and terminates failed workers', async () => {
  vi.useFakeTimers()
  const result = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const rejection = expect(result).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(120000)
  await rejection
  expect(current().terminate).toHaveBeenCalledTimes(1)
  const failed = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const failure = expect(failed).rejects.toThrow('worker failed')
  current().onerror?.()
  await failure
  expect(current().terminate).toHaveBeenCalledTimes(1)
})
