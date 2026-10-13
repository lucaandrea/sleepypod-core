// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { inspectInstalledShadowHost } from '../installed-host'
import { observedShadowHardware, installedShadowIdentity } from '../device-identity'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: vi.fn() }))
const now = 1700000000000
function monitor(version = 'J00', sensorLabel = '20600-0003-J55-B0708DE3', at: number | null = now, state = 'running') {
  vi.mocked(getDacMonitorIfRunning).mockReturnValue({ getStatus: () => state, getLastPollAt: () => at,
    getLastStatus: () => ({ podVersion: version, sensorLabel }) } as ReturnType<typeof getDacMonitorIfRunning>)
}
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())
it.each([['H00', 'H00'], ['I00', 'I11'], ['J00', 'J55']])('identifies %s by exact revision while discarding serials', (version, revision) => {
  monitor(version, `20600-${revision}-SERIAL`)
  expect(observedShadowHardware(1000, now)).toEqual({ hardwareId: `pod-sensor-v1/${version}/${revision}`, sampleRateHz: 500 })
})
it.each(['UNKNOWN', 'SERIAL-H00-JUNK-I11', '20600-K00-SERIAL', '20600-J550-SERIAL'])('rejects unknown or inconsistent sensor label %s', (label) => {
  monitor('J00', label)
  expect(() => observedShadowHardware(1000, now)).toThrow(/revision/)
})
it.each([null, now + 1, now - 1001])('rejects missing, future or stale poll %s', (at) => {
  monitor('J00', '20600-J55-SERIAL', at)
  expect(() => observedShadowHardware(1000, now)).toThrow()
})
it.each(['stopped', 'degraded'])('rejects %s monitors', (state) => {
  monitor('J00', '20600-J55-SERIAL', now, state)
  expect(() => observedShadowHardware(1000, now)).toThrow(/unavailable/)
})
it('rejects an absent monitor without initializing one', () => {
  vi.mocked(getDacMonitorIfRunning).mockReturnValue(null)
  expect(() => observedShadowHardware(1000, now)).toThrow(/unavailable/)
  expect(getDacMonitorIfRunning).toHaveBeenCalledOnce()
})

it('combines the inspected build with fresh qualified hardware and repeats artifact checks', () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  const guard = vi.fn()
  const inspection = { build: { hash: a, python: { hash: b } }, assertCurrent: guard } as unknown as Awaited<ReturnType<typeof inspectInstalledShadowHost>>
  const qualification = { qualificationId: 'test', manifestHash: a, engineBuildHash: a, pythonBuildHash: b,
    hardwareId: 'pod-sensor-v1/J00/J55', sampleRateHz: 500, activeConfigHash: a, executionPolicyHash: a,
    fixtureEvidenceHash: a, podEvidenceHash: a, heldOutEvidenceHash: a,
    contextEvidence: 'host_observations_not_live_processor_cache_attestation', maximumRuntimeHeartbeatAgeMs: 1000, maximumHardwareObservationAgeMs: 1000,
    healthPolicy: { qualificationId: 'test', minimumAvailableMemoryBytes: 1, minimumFreeDiskBytes: 1, maximumLoadPerCpu: 1,
      maximumEventLoopDelayMs: 100, maximumPiezoAgeMs: 1000, maximumTemperatureC: 70, maximumSampleAgeMs: 1000 } }
  expect(() => installedShadowIdentity(inspection, { ...qualification, pythonBuildHash: a })).toThrow(/build differs/)
  const identity = installedShadowIdentity(inspection, qualification)
  monitor()
  expect(identity()).toEqual({ engineBuildHash: a, pythonBuildHash: b, hardwareId: qualification.hardwareId, sampleRateHz: 500 })
  monitor('I00', '20600-I11-SERIAL')
  expect(identity).toThrow(/hardware differs/)
  expect(guard).toHaveBeenCalledTimes(2)
  guard.mockImplementation(() => {
    throw new Error('artifact changed')
  })
  expect(identity).toThrow(/artifact changed/)
})
