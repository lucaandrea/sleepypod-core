import { readFile, statfs } from 'node:fs/promises'
import { availableParallelism, loadavg } from 'node:os'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'

/** Limits must come from an explicitly qualified deployment policy. There is
 * no fallback that silently enables replay on an unmeasured device. */
export const admissionPolicySchema = z.object({
  qualificationId: z.string().min(1).max(200),
  minimumAvailableMemoryBytes: z.number().int().positive(),
  minimumFreeDiskBytes: z.number().int().positive(),
  maximumLoadPerCpu: z.number().positive(),
  maximumEventLoopDelayMs: z.number().positive(),
  maximumPiezoAgeMs: z.number().int().positive(),
  maximumTemperatureC: z.number().positive(),
  maximumSampleAgeMs: z.number().int().positive(),
}).strict()
export type AdmissionPolicy = z.infer<typeof admissionPolicySchema>
const sampleSchema = z.object({
  measuredAtMs: z.number().int().nonnegative(),
  availableMemoryBytes: z.number().int().nonnegative(),
  freeDiskBytes: z.number().int().nonnegative(),
  loadPerCpu: z.number().nonnegative(),
  eventLoopDelayMs: z.number().nonnegative(),
  piezoReceivedAtMs: z.number().int().nonnegative(),
  temperatureC: z.number().min(-50).max(150),
}).strict()
export type AdmissionSample = z.infer<typeof sampleSchema>
export type AdmissionReason = 'unqualified' | 'health_unavailable' | 'stale_sample' | 'clock_skew'
  | 'memory_pressure' | 'disk_pressure' | 'cpu_pressure' | 'event_loop_delay' | 'piezo_stale' | 'temperature'

export function evaluateAdmission(rawSample: unknown, rawPolicy: unknown, now = Date.now()): { admitted: boolean, reasons: AdmissionReason[] } {
  const policy = admissionPolicySchema.safeParse(rawPolicy)
  if (!policy.success) return { admitted: false, reasons: ['unqualified'] }
  const sample = sampleSchema.safeParse(rawSample)
  if (!sample.success || !Number.isSafeInteger(now) || now < 0) return { admitted: false, reasons: ['health_unavailable'] }
  const s = sample.data, p = policy.data
  const reasons: AdmissionReason[] = []
  if (s.measuredAtMs > now || s.piezoReceivedAtMs > now) reasons.push('clock_skew')
  if (now - s.measuredAtMs > p.maximumSampleAgeMs) reasons.push('stale_sample')
  if (s.availableMemoryBytes < p.minimumAvailableMemoryBytes) reasons.push('memory_pressure')
  if (s.freeDiskBytes < p.minimumFreeDiskBytes) reasons.push('disk_pressure')
  if (s.loadPerCpu > p.maximumLoadPerCpu) reasons.push('cpu_pressure')
  if (s.eventLoopDelayMs > p.maximumEventLoopDelayMs) reasons.push('event_loop_delay')
  if (now - s.piezoReceivedAtMs > p.maximumPiezoAgeMs) reasons.push('piezo_stale')
  if (s.temperatureC > p.maximumTemperatureC) reasons.push('temperature')
  return { admitted: reasons.length === 0, reasons }
}

export function parseAvailableMemory(text: string) {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text)
  if (!match) throw new Error('Available memory is unavailable')
  const bytes = Number(match[1]) * 1024
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid available memory')
  return bytes
}

/** No hardware commands, database queries, or lifetime histogram. Measure the
 * scheduling delay of this process and only the live piezo frame timestamp. */
export async function collectAdmissionSample(databaseDirectory: string, piezoReceivedAt: () => number | undefined): Promise<AdmissionSample | null> {
  const measuredAtMs = Date.now()
  try {
    // Probe Linux health files directly. Turbopack folds both process.platform
    // and os.platform() to the build host; missing runtime files fail closed.
    const probeStarted = performance.now()
    const [memory, disk, thermal, delay] = await Promise.all([
      readFile('/proc/meminfo', 'utf8'),
      statfs(databaseDirectory),
      readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8'),
      new Promise<number>(resolve => setTimeout(() => resolve(Math.max(0, performance.now() - probeStarted - 20)), 20)),
    ])
    const rawTemperature = thermal.trim()
    if (!/^-?\d+$/.test(rawTemperature)) return null
    const parsed = sampleSchema.safeParse({
      measuredAtMs, availableMemoryBytes: parseAvailableMemory(memory), freeDiskBytes: disk.bavail * disk.bsize,
      loadPerCpu: loadavg()[0] / availableParallelism(), eventLoopDelayMs: delay,
      piezoReceivedAtMs: piezoReceivedAt(), temperatureC: Number(rawTemperature) / 1000,
    })
    return parsed.success ? parsed.data : null
  }
  catch { return null }
}
