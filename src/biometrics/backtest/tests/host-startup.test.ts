// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { startConfiguredBacktestHost } from '../host-startup'
import { startBacktestHost } from '../host'
vi.mock('../host', () => ({ startBacktestHost: vi.fn(() => ({ started: true })) }))
const db = {} as Parameters<typeof startConfiguredBacktestHost>[0]
const policy = { qualificationId: 'test-only', minimumAvailableMemoryBytes: 100, minimumFreeDiskBytes: 100,
  maximumLoadPerCpu: 1, maximumEventLoopDelayMs: 100, maximumPiezoAgeMs: 10000, maximumTemperatureC: 65, maximumSampleAgeMs: 1000 }
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it.each([undefined, '', '{}', '{', JSON.stringify({ ...policy, maximumLoadPerCpu: 0 })])('does not start background work without valid deployment policy: %s', (value) => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', value)
  expect(startConfiguredBacktestHost(db)).toBeNull()
  expect(startBacktestHost).not.toHaveBeenCalled()
})
it('starts with a fresh admission closure and denies after policy removal', async () => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', JSON.stringify(policy))
  expect(startConfiguredBacktestHost(db)).toEqual({ started: true })
  expect(startBacktestHost).toHaveBeenCalledWith(db, expect.any(Function), expect.any(Function))
  const admit = vi.mocked(startBacktestHost).mock.calls[0][1]
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', undefined)
  expect(await admit()).toBe(false)
})
