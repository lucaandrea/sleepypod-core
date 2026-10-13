import { z } from 'zod'
import { waveformProcessResourcesSchema } from './waveform-output'

export const waveformResourceSummarySchema = z.object({
  version: z.literal('waveform-resource-summary-v1'),
  scope: z.literal('sequential_python_processes_excluding_coordinator_and_scorer'),
  expectedProcesses: z.number().int().min(0).max(180), measuredProcesses: z.number().int().min(0).max(180),
  totalWallMs: z.number().finite().nonnegative().nullable(), totalCpuMs: z.number().finite().nonnegative().nullable(),
  largestProcessPeakRssBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  ingestionHealthMeasured: z.literal(false),
}).strict()

/** Sequential workers: sum durations and retain the largest process high water
 * mark. This deliberately does not claim simultaneous job RSS or live health. */
export function summarizeWaveformResources(outputs: Array<{ run: { resources?: z.infer<typeof waveformProcessResourcesSchema> } }>) {
  const measured = outputs.flatMap(output => output.run.resources ? [waveformProcessResourcesSchema.parse(output.run.resources)] : [])
  const complete = outputs.length > 0 && measured.length === outputs.length
  const memoryComplete = complete && measured.every(row => row.peakRssBytes !== null)
  return {
    version: 'waveform-resource-summary-v1' as const,
    scope: 'sequential_python_processes_excluding_coordinator_and_scorer' as const,
    expectedProcesses: outputs.length, measuredProcesses: measured.length,
    totalWallMs: complete ? measured.reduce((sum, row) => sum + row.wallMs, 0) : null,
    totalCpuMs: complete ? measured.reduce((sum, row) => sum + row.cpuMs, 0) : null,
    largestProcessPeakRssBytes: memoryComplete ? Math.max(...measured.map(row => row.peakRssBytes ?? 0)) : null,
    ingestionHealthMeasured: false as const,
  }
}
