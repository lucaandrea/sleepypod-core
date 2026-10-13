// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { CoordinatorQueue } from '../coordinator-queue'
const options = { databasePath: '/unused.db', coordinatorPath: '/unused.cjs', workerPath: '/unused-worker.cjs' }
afterEach(() => vi.useRealTimers())
const report = { type: 'readSummary' as const, input: { id: '00000000-0000-4000-8000-000000000001' } }

it('serializes report readers and frees the read slot after a failure without stopping replay', async () => {
  const children: { task: string, resolve: (value: null) => void, reject: (error: Error) => void }[] = []
  const execute = vi.fn().mockImplementation((_options, task) => new Promise((resolve, reject) => {
    children.push({ task: task.type, resolve, reject })
  }))
  const queue = new CoordinatorQueue(options, execute)
  const replay = queue.request({ type: 'execute', owner: 'test' })
  const failedRead = expect(queue.request(report)).rejects.toThrow('Unreadable report')
  const nextRead = queue.request(report)
  expect(children.map(child => child.task)).toEqual(['execute', 'readSummary'])
  children[1].reject(new Error('Unreadable report'))
  await failedRead
  expect(children.map(child => child.task)).toEqual(['execute', 'readSummary', 'readSummary'])
  children[2].resolve(null)
  await nextRead
  children[0].resolve(null)
  await replay
  await queue.stop()
})

it('serves sequential report reads while replay occupies the work slot', async () => {
  let finishReplay: (() => void) | undefined
  const execute = vi.fn().mockImplementation((_options, task) => task.type === 'execute'
    ? new Promise((resolve) => { finishReplay = () => resolve(null) })
    : Promise.resolve(null))
  const queue = new CoordinatorQueue(options, execute)
  const replay = queue.request({ type: 'execute', owner: 'test' })
  const scan = queue.request({ type: 'inspectRawSource', input: { afterName: null } })
  await queue.request(report)
  await queue.request(report)
  expect(execute.mock.calls.map(call => call[1].type)).toEqual(['execute', 'readSummary', 'readSummary'])
  finishReplay?.()
  await Promise.all([replay, scan])
  expect(execute.mock.calls.map(call => call[1].type)).toEqual(['execute', 'readSummary', 'readSummary', 'inspectRawSource'])
  await queue.stop()
})

it('bounds both lanes and cancels both active children on shutdown without starting pending work', async () => {
  const execute = vi.fn().mockImplementation((_options, _task, control) => new Promise((resolve) => {
    control.signal.addEventListener('abort', () => resolve(null))
  }))
  const queue = new CoordinatorQueue(options, execute)
  const reads = Array.from({ length: 7 }, () => queue.request(report).catch(error => error))
  await expect(queue.request(report)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  const replay = queue.request({ type: 'execute', owner: 'test' })
  await expect(queue.request({ type: 'collectArtifacts' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  expect(execute).toHaveBeenCalledTimes(2)
  await queue.stop()
  const outcomes = await Promise.all(reads)
  await replay
  expect(outcomes.slice(1).every(error => error instanceof Error)).toBe(true)
  expect(execute.mock.calls.every(call => call[2].signal.aborted)).toBe(true)
  expect(execute).toHaveBeenCalledTimes(2)
})

it('reserves read capacity while limiting and serializing active plus queued work', async () => {
  let release: (() => void) | undefined
  const execute = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(null)
  })).mockResolvedValue(null)
  const queue = new CoordinatorQueue(options, execute)
  const requests = Array.from({ length: 7 }, () => queue.request({ type: 'collectArtifacts' }))
  await expect(queue.request({ type: 'collectArtifacts' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  expect(execute).toHaveBeenCalledTimes(1)
  release?.()
  await Promise.all(requests)
  expect(execute).toHaveBeenCalledTimes(7)
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
