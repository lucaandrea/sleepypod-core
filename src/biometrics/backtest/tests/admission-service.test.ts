// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type * as Admission from '../admission'
import { collectAdmissionSample } from '../admission'
import { replayAdmission, replayAdmitter } from '../admission-service'

const frames = vi.hoisted(() => ({ 'piezo-dual': 1000 }))
vi.mock('@/src/streaming/piezoStream', () => ({ getSensorFrameTimes: () => frames }))
vi.mock('../admission', async original => ({ ...await original<typeof Admission>(), collectAdmissionSample: vi.fn() }))
const db = { all: vi.fn(() => [{ name: 'main', file: '/private/biometrics.db' }]) } as unknown as Parameters<typeof replayAdmission>[0]
const policy = { qualificationId: 'test-evidence', minimumAvailableMemoryBytes: 100, minimumFreeDiskBytes: 100,
  maximumLoadPerCpu: 1, maximumEventLoopDelayMs: 100, maximumPiezoAgeMs: 10000, maximumTemperatureC: 65, maximumSampleAgeMs: 1000 }
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each([undefined, '', '{', '{}', JSON.stringify({ ...policy, maximumPiezoAgeMs: 0 })])('denies missing or invalid server policy without collecting health: %s', async (value) => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', value)
  expect(await replayAdmission(db)).toEqual({ configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] })
  expect(collectAdmissionSample).not.toHaveBeenCalled()
})

it('uses fresh piezo receipt times and reevaluates health for every admission', async () => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', JSON.stringify(policy))
  vi.mocked(collectAdmissionSample).mockImplementation(async (directory, piezo) => {
    expect(directory).toBe('/private')
    expect(piezo()).toBe(frames['piezo-dual'])
    return { measuredAtMs: Date.now(), piezoReceivedAtMs: Date.now(), availableMemoryBytes: 200, freeDiskBytes: 200,
      loadPerCpu: 0.2, eventLoopDelayMs: 2, temperatureC: 30 }
  })
  expect(await replayAdmission(db)).toEqual({ configured: true, qualificationId: 'test-evidence', admitted: true, reasons: [] })
  vi.mocked(collectAdmissionSample).mockResolvedValueOnce(null)
  expect(await replayAdmitter(db)()).toBe(false)
  expect(collectAdmissionSample).toHaveBeenCalledTimes(2)
})

it('fails closed when collecting health throws', async () => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', JSON.stringify(policy))
  vi.mocked(collectAdmissionSample).mockRejectedValueOnce(new Error('unavailable'))
  expect(await replayAdmission(db)).toEqual({ configured: true, qualificationId: 'test-evidence', admitted: false, reasons: ['health_unavailable'] })
})

it('returns the admitted sample only through the internal health callback', async () => {
  const { replayHealthAdmission } = await import('../admission-service')
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY', JSON.stringify(policy))
  vi.mocked(collectAdmissionSample).mockImplementation(async () => ({ measuredAtMs: Date.now(), piezoReceivedAtMs: Date.now() - 250,
    availableMemoryBytes: 200, freeDiskBytes: 200, loadPerCpu: 0.2, eventLoopDelayMs: 2, temperatureC: 30 }))
  const measured = await replayHealthAdmission(db)()
  expect(measured).toMatchObject({ allowed: true, sample: { qualificationId: 'test-evidence', ingestionAgeMs: expect.any(Number) } })
  expect(measured.sample?.ingestionAgeMs).toBeGreaterThanOrEqual(250)
  expect(await replayAdmission(db)).not.toHaveProperty('receipt')
  vi.mocked(collectAdmissionSample).mockResolvedValueOnce(null)
  expect(await replayHealthAdmission(db)()).toEqual({ allowed: false, sample: null })
})
