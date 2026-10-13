// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ResourceObservations, startResourceMonitor } from './resources'
const sample = { sourceTimestampMs: 1000, cpuMs: 10, memoryBytes: 1000000, processes: 1 }
describe('host experiment resource evidence', () => {
  it('retains maxima and includes initial, interior and final observation gaps', () => {
    const readings = new ResourceObservations(0)
    readings.record(sample, 100)
    readings.record({ ...sample, sourceTimestampMs: 2000, cpuMs: 20, memoryBytes: 900000, processes: 2 }, 400)
    expect(readings.snapshot(1000)).toMatchObject({ attempts: 2, samples: 2, allAttemptsMeasured: true,
      maximumObservedCpuMs: 20, peakObservedMemoryBytes: 1000000, maximumObservedProcesses: 2,
      maximumObservationGapMs: 600, exactLifetimeCpu: false, exactPeakMemory: false })
  })
  it('marks failed, stale, regressing and invalid observations incomplete', () => {
    const readings = new ResourceObservations(0)
    readings.record(sample, 100)
    readings.record(null, 200)
    readings.record(sample, 300)
    readings.record({ ...sample, sourceTimestampMs: 2000, cpuMs: 1 }, 400)
    readings.record({ ...sample, sourceTimestampMs: 2000, memoryBytes: NaN }, 500)
    expect(readings.snapshot(1000)).toMatchObject({ attempts: 5, samples: 1, allAttemptsMeasured: false, maximumObservationGapMs: 900 })
    expect(new ResourceObservations(0).snapshot(1000)).toMatchObject({ samples: 0, allAttemptsMeasured: false,
      maximumObservedCpuMs: null, peakObservedMemoryBytes: null })
  })
  it('coalesces concurrent reads and waits for a pending observation at stop', async () => {
    let resolve: (value: typeof sample) => void = () => undefined
    let calls = 0
    const monitor = startResourceMonitor(() => {
      calls++
      return new Promise<typeof sample>((done) => {
        resolve = done
      })
    }, 0)
    const first = monitor.sample(), second = monitor.sample()
    expect(first).toBe(second)
    const stopping = monitor.stop()
    resolve(sample)
    expect(await stopping).toMatchObject({ attempts: 1, samples: 1 })
    expect(calls).toBe(1)
  })
  it('reports an unavailable transport rather than fabricated zero usage', async () => {
    const monitor = startResourceMonitor(null, 0)
    await monitor.sample()
    expect(await monitor.stop()).toMatchObject({ attempts: 1, samples: 0, allAttemptsMeasured: false, maximumObservedCpuMs: null })
  })
})
