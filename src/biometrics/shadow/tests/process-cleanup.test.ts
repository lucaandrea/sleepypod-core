// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { confirmShadowProcessCleanup } from '../process-cleanup'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const missing = () => {
  throw Object.assign(new Error('missing'), { code: 'ESRCH' })
}
it('requires disappearance of descendants even after the direct child closes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  let settled = false
  const result = confirmShadowProcessCleanup(123, () => true).then((value) => {
    settled = true
    return value
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  kill.mockImplementation(missing)
  await vi.advanceTimersByTimeAsync(25)
  expect(await result).toBe(true)
  expect(kill.mock.calls.every(args => args[0] === -123 && args[1] === 0)).toBe(true)
})
it('requires the close event even after the group disappears', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  vi.spyOn(process, 'kill').mockImplementation(missing)
  let closed = false, settled = false
  const result = confirmShadowProcessCleanup(123, () => closed).then((value) => {
    settled = true
    return value
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  closed = true
  await vi.advanceTimersByTimeAsync(25)
  expect(await result).toBe(true)
})
it('bounds confirmation when a group still exists and when close is missing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const alive = confirmShadowProcessCleanup(123, () => true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await alive).toBe(false)
  kill.mockImplementation(missing)
  const unclosed = confirmShadowProcessCleanup(123, () => false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await unclosed).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it('treats probe denial as unknown and never signals invalid or missing pids', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' })
  })
  const denied = confirmShadowProcessCleanup(123, () => true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await denied).toBe(false)
  kill.mockClear()
  for (const pid of [0, -1, NaN, Infinity, 1.5]) expect(await confirmShadowProcessCleanup(pid, () => true)).toBe(false)
  expect(await confirmShadowProcessCleanup(undefined, () => true)).toBe(true)
  expect(kill).not.toHaveBeenCalled()
})

it('retries transient unknown observations but still requires explicit absence', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
    throw Object.assign(new Error('reaping'), { code: 'EPERM' })
  }).mockImplementation(missing)
  const result = confirmShadowProcessCleanup(123, () => true)
  expect(kill).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(25)
  expect(await result).toBe(true)
  expect(kill).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
