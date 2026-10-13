// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ readFile: vi.fn(), statfs: vi.fn(), loadavg: vi.fn(), availableParallelism: vi.fn(), platform: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, statfs: mocks.statfs }))
vi.mock('node:os', () => ({ loadavg: mocks.loadavg, availableParallelism: mocks.availableParallelism, platform: mocks.platform }))
import { collectAdmissionSample } from '../admission'
beforeEach(() => {
  mocks.platform.mockReturnValue('linux')
  mocks.readFile.mockImplementation(async (path: string) => path === '/proc/meminfo' ? 'MemAvailable: 1024 kB\n' : '35000\n')
  mocks.statfs.mockResolvedValue({ bavail: 100, bsize: 4096 })
  mocks.loadavg.mockReturnValue([2, 1, 1])
  mocks.availableParallelism.mockReturnValue(4)
})
afterEach(() => {
  vi.resetAllMocks()
})
it('collects available disk/memory and a current scheduling probe with a piezo timestamp', async () => {
  const before = Date.now()
  const sample = await collectAdmissionSample('/fixture/data', () => before - 100)
  expect(sample).toMatchObject({ availableMemoryBytes: 1048576, freeDiskBytes: 409600, loadPerCpu: 0.5,
    temperatureC: 35, piezoReceivedAtMs: before - 100 })
  expect(sample?.measuredAtMs).toBeGreaterThanOrEqual(before)
  expect(sample?.measuredAtMs).toBeLessThanOrEqual(Date.now())
  expect(sample?.eventLoopDelayMs).toBeGreaterThanOrEqual(0)
  expect(mocks.statfs).toHaveBeenCalledWith('/fixture/data')
})
it('returns unavailable when piezo has never been observed', async () => {
  expect(await collectAdmissionSample('/fixture/data', () => undefined)).toBeNull()
})
it('does not convert empty thermal files into a zero-degree reading', async () => {
  mocks.readFile.mockImplementation(async (path: string) => path === '/proc/meminfo' ? 'MemAvailable: 1024 kB\n' : '\n')
  expect(await collectAdmissionSample('/fixture/data', Date.now)).toBeNull()
})
it('returns unavailable on collector failures and unsupported platforms', async () => {
  mocks.statfs.mockRejectedValue(new Error('I/O error'))
  expect(await collectAdmissionSample('/fixture/data', Date.now)).toBeNull()
  mocks.statfs.mockClear()
  mocks.platform.mockReturnValue('darwin')
  expect(await collectAdmissionSample('/fixture/data', Date.now)).toBeNull()
  expect(mocks.statfs).not.toHaveBeenCalled()
})
