// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openShadowFrameSource } from '../frame-source'
import { publishProspectiveFrame, subscribeProspectiveFrames } from '../../../streaming/prospectiveFrameTap'
const start = 1700000000000
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
})
afterEach(() => {
  cleanups.splice(0).forEach(close => close())
  vi.useRealTimers()
})
function setup(maximumFrames = 2, maximumBytes = 100000) {
  const fail = vi.fn(), context = { activeSides: ['left'], leftOccupied: true, rightOccupied: false, pumpContextKnown: false }
  const controller = new AbortController()
  const source = openShadowFrameSource({ startMs: start, endMs: start + 1000, signal: controller.signal,
    budgets: { maximumFrames, maximumBytes, maximumEventAgeMs: 10000, maximumFutureSkewMs: 0 }, context: () => context, fail })
  cleanups.push(source.close)
  return { source, iterator: source.frames[Symbol.asyncIterator](), fail, context, controller }
}
const frame = () => ({ type: 'piezo-dual', ts: start / 1000, freq: 500, left1: [-2147483648, 0, 2147483647], right1: [1, -2, 3] })
function publish(value = frame(), backlog = false) {
  publishProspectiveFrame(value, backlog, Date.now())
}
it('snapshots signed int32 waveforms and arrival context without retaining mutable stream data', async () => {
  const { iterator, context } = setup()
  const value = frame()
  publish(value)
  value.left1[0] = 99
  context.activeSides[0] = 'right'
  const row = (await iterator.next()).value
  expect(row).toMatchObject({ type: 'frame', observedAtMs: start, record: { type: 'piezo-dual', freq: 500 }, context: { activeSides: ['left'] } })
  const bytes = Buffer.from(row.record.left1, 'base64')
  expect([0, 4, 8].map(offset => bytes.readInt32LE(offset))).toEqual([-2147483648, 0, 2147483647])
})
it('excludes backlog and unrelated sensors from prospective evidence', async () => {
  const { iterator, fail } = setup()
  publish(frame(), true)
  publishProspectiveFrame({ type: 'capSense' }, false, start)
  const next = iterator.next()
  publish()
  expect((await next).value.record.type).toBe('piezo-dual')
  expect(fail).not.toHaveBeenCalled()
})
it('preserves only the bounded pump fields used by the shared gate', async () => {
  const { iterator } = setup()
  publishProspectiveFrame({ type: 'frzHealth', ts: start / 1000, left: { pumpRpm: 0, pump: { rpm: '1200', duty: 30 }, unrelated: 'discard' }, right: { duty: 0 } }, false, start)
  expect((await iterator.next()).value.record).toEqual({ type: 'frzHealth', ts: start / 1000, left: { pumpRpm: 0, pump: { rpm: '1200', duty: 30 } }, right: { duty: 0 } })
})
it.each(['frames', 'bytes'])('fails and closes on %s queue overflow', async (kind) => {
  const { iterator, fail } = setup(1, kind === 'bytes' ? 1 : 100000)
  publish()
  if (kind === 'frames') publish()
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
  publish()
  expect(fail).toHaveBeenCalledOnce()
})
it.each([Array(5001).fill(0), [2147483648], [1.5], [NaN]])('rejects malformed or oversized channel before queueing', async (left1) => {
  const { iterator, fail } = setup()
  publish({ ...frame(), left1 })
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('ends pending reads and unsubscribes on abort', async () => {
  const { iterator, controller, fail } = setup()
  const pending = iterator.next()
  controller.abort()
  expect((await pending).done).toBe(true)
  publish()
  expect(fail).not.toHaveBeenCalled()
})
it('reports unread input at collection end instead of silently dropping it', async () => {
  const { iterator, fail } = setup()
  publish()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('ends an empty collection normally and rejects concurrent consumers', async () => {
  const { source, iterator, fail } = setup()
  expect(() => source.frames[Symbol.asyncIterator]()).toThrow(/one consumer/)
  const pending = iterator.next()
  await expect(iterator.next()).rejects.toThrow(/Concurrent/)
  await vi.advanceTimersByTimeAsync(1000)
  expect((await pending).done).toBe(true)
  expect(fail).not.toHaveBeenCalled()
})
it('isolates subscriber faults so live ingestion and other subscribers continue', () => {
  const failed = vi.fn(), healthy = vi.fn()
  cleanups.push(subscribeProspectiveFrames({ frame: () => {
    throw new Error('consumer failed')
  }, failed }))
  cleanups.push(subscribeProspectiveFrames({ frame: healthy, failed: () => {} }))
  expect(() => publish()).not.toThrow()
  publish()
  expect(failed).toHaveBeenCalledOnce()
  expect(healthy).toHaveBeenCalledTimes(2)
})
it('unwinds subscriptions and timers when subscriber admission fails', () => {
  for (let i = 0; i < 4; i++) cleanups.push(subscribeProspectiveFrames({ frame: () => {}, failed: () => {} }))
  expect(() => setup()).toThrow(/subscriber limit/)
  expect(vi.getTimerCount()).toBe(0)
})
it.each([-20, 1])('fails on stale/future event timestamps (%s seconds)', async (seconds) => {
  const { iterator, fail } = setup()
  publish({ ...frame(), ts: start / 1000 + seconds })
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('releases queue byte capacity when a frame is consumed', async () => {
  const { iterator, fail } = setup(1, 1000)
  publish()
  await iterator.next()
  publish()
  expect((await iterator.next()).done).toBe(false)
  expect(fail).not.toHaveBeenCalled()
})
it('isolates a failing consumer notification from the collection timer', async () => {
  const { iterator, fail } = setup()
  fail.mockImplementation(() => {
    throw new Error('consumer failed')
  })
  publish()
  await expect(vi.advanceTimersByTimeAsync(1000)).resolves.toBeDefined()
  expect((await iterator.next()).done).toBe(true)
})
