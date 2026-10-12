// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { CoordinatorQueue } from '../coordinator-queue'
const options = { databasePath: '/unused.db', coordinatorPath: '/unused.cjs', workerPath: '/unused-worker.cjs' }
afterEach(() => vi.useRealTimers())
it('limits active plus queued work and runs it serially', async () => {
  let release: (() => void) | undefined
  const execute = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(null)
  })).mockResolvedValue(null)
  const queue = new CoordinatorQueue(options, execute)
  const requests = Array.from({ length: 8 }, () => queue.request({ type: 'collectArtifacts' }))
  await expect(queue.request({ type: 'collectArtifacts' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  expect(execute).toHaveBeenCalledTimes(1)
  release?.()
  await Promise.all(requests)
  expect(execute).toHaveBeenCalledTimes(8)
  await queue.stop()
})
it('expires queued requests without executing them and propagates cancellation to active work', async () => {
  vi.useFakeTimers()
  let release: (() => void) | undefined
  const execute = vi.fn().mockImplementation((_options, _task, control) => new Promise((resolve) => {
    release = () => resolve(null)
    control.signal.addEventListener('abort', () => resolve(null))
  }))
  const queue = new CoordinatorQueue(options, execute)
  const running = queue.request({ type: 'collectArtifacts' })
  const pending = expect(queue.request({ type: 'collectArtifacts' })).rejects.toThrow('queue wait exceeded')
  await vi.advanceTimersByTimeAsync(30000)
  await pending
  expect(execute).toHaveBeenCalledTimes(1)
  await queue.stop()
  await running
  expect(execute.mock.calls[0][2].signal.aborted).toBe(true)
  release?.()
  await expect(queue.request({ type: 'collectArtifacts' })).rejects.toThrow('stopped')
})
it('removes a cancelled queued request without waiting for the active operation', async () => {
  let release: (() => void) | undefined
  const execute = vi.fn().mockImplementation(() => new Promise((resolve) => {
    release = () => resolve(null)
  }))
  const queue = new CoordinatorQueue(options, execute)
  const first = queue.request({ type: 'collectArtifacts' })
  const controller = new AbortController()
  const cancelled = queue.request({ type: 'collectArtifacts' }, { signal: controller.signal })
  controller.abort()
  await expect(cancelled).rejects.toThrow('cancelled')
  release?.()
  await first
  await queue.stop()
  expect(execute).toHaveBeenCalledTimes(1)
})
