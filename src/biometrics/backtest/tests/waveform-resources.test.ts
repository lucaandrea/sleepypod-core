// @vitest-environment node
import { expect, it } from 'vitest'
import { summarizeWaveformResources } from '../waveform-resources'
const resources = { version: 'waveform-process-resources-v1' as const, wallMs: 100, cpuMs: 80, peakRssBytes: 500,
  scope: 'python_process_until_result' as const, memoryScope: 'process_lifetime_high_water_mark' as const }
it('sums sequential work without summing process memory peaks or claiming live health', () => {
  expect(summarizeWaveformResources([{ run: { resources } }, { run: { resources: { ...resources, peakRssBytes: 700 } } }])).toMatchObject({
    expectedProcesses: 2, measuredProcesses: 2, totalWallMs: 200, totalCpuMs: 160, largestProcessPeakRssBytes: 700, ingestionHealthMeasured: false,
  })
})
it('does not turn absent legacy measurements or missing kernel telemetry into zero', () => {
  expect(summarizeWaveformResources([])).toMatchObject({ totalWallMs: null, totalCpuMs: null, largestProcessPeakRssBytes: null })
  expect(summarizeWaveformResources([{ run: {} }, { run: { resources } }])).toMatchObject({ measuredProcesses: 1, totalWallMs: null, totalCpuMs: null, largestProcessPeakRssBytes: null })
  expect(summarizeWaveformResources([{ run: { resources: { ...resources, peakRssBytes: null } } }])).toMatchObject({ totalWallMs: 100, totalCpuMs: 80, largestProcessPeakRssBytes: null })
})
it('rejects invalid measurement units and nonfinite counters', () => {
  for (const bad of [{ wallMs: -1 }, { cpuMs: Infinity }, { peakRssBytes: 0 }, { peakRssBytes: 2 ** 53 }, { scope: 'whole_job' }]) {
    expect(() => summarizeWaveformResources([{ run: { resources: { ...resources, ...bad } as typeof resources } }])).toThrow()
  }
})
