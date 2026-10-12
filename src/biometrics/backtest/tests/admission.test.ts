// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { evaluateAdmission, parseAvailableMemory, type AdmissionPolicy, type AdmissionSample } from '../admission'
// Test values deliberately are not deployment defaults.
const policy: AdmissionPolicy = { qualificationId: 'fixture', minimumAvailableMemoryBytes: 1000, minimumFreeDiskBytes: 2000,
  maximumLoadPerCpu: 0.8, maximumEventLoopDelayMs: 50, maximumPiezoAgeMs: 1000, maximumTemperatureC: 60, maximumSampleAgeMs: 500 }
const sample: AdmissionSample = { measuredAtMs: 10000, availableMemoryBytes: 1000, freeDiskBytes: 2000,
  loadPerCpu: 0.8, eventLoopDelayMs: 50, piezoReceivedAtMs: 9500, temperatureC: 60 }
describe('replay resource admission', () => {
  it('admits fresh evidence at exact qualified boundaries', () => {
    expect(evaluateAdmission(sample, policy, 10500)).toEqual({ admitted: true, reasons: [] })
  })
  it.each([
    ['availableMemoryBytes', 999, 'memory_pressure'], ['freeDiskBytes', 1999, 'disk_pressure'],
    ['loadPerCpu', 0.81, 'cpu_pressure'], ['eventLoopDelayMs', 51, 'event_loop_delay'],
    ['piezoReceivedAtMs', 8999, 'piezo_stale'], ['temperatureC', 61, 'temperature'],
    ['measuredAtMs', 9499, 'stale_sample'], ['piezoReceivedAtMs', 10001, 'clock_skew'],
    ['measuredAtMs', 10001, 'clock_skew'],
  ])('defers for %s outside the qualified range', (key, value, reason) => {
    expect(evaluateAdmission({ ...sample, [key]: value }, policy, 10000)).toEqual({ admitted: false, reasons: [reason] })
  })
  it('does not turn absent, malformed, or nonfinite health evidence into zeros', () => {
    for (const invalid of [null, {}, { ...sample, availableMemoryBytes: undefined }, { ...sample, temperatureC: NaN }, { ...sample, freeDiskBytes: Infinity }]) {
      expect(evaluateAdmission(invalid, policy, 10000)).toEqual({ admitted: false, reasons: ['health_unavailable'] })
    }
    expect(evaluateAdmission(sample, null, 10000)).toEqual({ admitted: false, reasons: ['unqualified'] })
    expect(evaluateAdmission(sample, { ...policy, maximumLoadPerCpu: 0 }, 10000).admitted).toBe(false)
  })
  it('reports simultaneous pressure without hiding subsequent reasons', () => {
    expect(evaluateAdmission({ ...sample, availableMemoryBytes: 0, freeDiskBytes: 0, temperatureC: 70 }, policy, 10000).reasons)
      .toEqual(['memory_pressure', 'disk_pressure', 'temperature'])
  })
  it('reads reclaimable available Linux memory, not only unused pages', () => {
    expect(parseAvailableMemory('MemTotal: 2000 kB\nMemFree: 100 kB\nMemAvailable: 1200 kB\n')).toBe(1228800)
    for (const invalid of ['MemFree: 100 kB', 'MemAvailable: -1 kB', 'MemAvailable: 2 MB', 'MemAvailable: 99999999999999999 kB']) {
      expect(() => parseAvailableMemory(invalid)).toThrow()
    }
  })
})
