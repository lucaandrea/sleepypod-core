import { execFile } from 'node:child_process'
import { get } from 'node:http'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'

const exec = promisify(execFile)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const statsSchema = z.object({ read: z.string(), id: z.string().regex(/^[a-f0-9]{64}$/),
  cpu_stats: z.object({ cpu_usage: z.object({ total_usage: counter }) }),
  memory_stats: z.object({ usage: counter.positive() }), pids_stats: z.object({ current: counter.positive() }),
})

function dockerJson(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get({ socketPath, path }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('Docker measurement unavailable'))
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 128 * 1024) request.destroy(new Error('Docker measurement byte limit'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        }
        catch (error) { reject(error) }
      })
    })
    const timeout = setTimeout(() => request.destroy(new Error('Docker measurement timeout')), 1500)
    request.on('error', reject)
    request.on('close', () => clearTimeout(timeout))
  })
}

/** Independent host evidence. Never accepts counters emitted by candidate code.
 * Unsupported remote Docker transports remain explicitly unmeasured. */
export async function dockerResourceReader(containerId: string) {
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid measured container identity')
  const host = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    ? process.env.DOCKER_HOST
    : JSON.parse((await exec('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { timeout: 5000, maxBuffer: 16384 })).stdout) as string
  if (!host.startsWith('unix:///')) throw new Error('Resource measurement requires a local Unix Docker endpoint')
  const socket = host.slice('unix://'.length)
  const version = z.object({ ApiVersion: z.string().regex(/^1\.\d+$/) }).parse(await dockerJson(socket, '/version')).ApiVersion
  if (Number(version.split('.')[1]) < 41) throw new Error('Docker API does not support one-shot resource measurements')
  return async () => {
    const value = statsSchema.parse(await dockerJson(socket, `/v${version}/containers/${containerId}/stats?stream=false&one-shot=true`))
    if (value.id !== containerId) throw new Error('Measured container identity mismatch')
    const sourceTimestampMs = Date.parse(value.read)
    if (!Number.isFinite(sourceTimestampMs) || sourceTimestampMs <= 0) throw new Error('Invalid resource observation timestamp')
    return { sourceTimestampMs, cpuMs: value.cpu_stats.cpu_usage.total_usage / 1e6, memoryBytes: value.memory_stats.usage, processes: value.pids_stats.current }
  }
}

interface Observation { sourceTimestampMs: number, cpuMs: number, memoryBytes: number, processes: number }
export class ResourceObservations {
  private attempts = 0
  private samples = 0
  private peakMemoryBytes: number | null = null
  private maximumCpuMs: number | null = null
  private maximumProcesses: number | null = null
  private sourceTimestampMs = 0
  private lastAt: number
  private maximumGapMs = 0
  constructor(private readonly startedAt: number) { this.lastAt = startedAt }
  record(value: Observation | null, at: number) {
    this.attempts++
    if (!value || ![value.cpuMs, value.memoryBytes, value.processes].every(number => Number.isFinite(number) && number >= 0)) return
    if (!Number.isFinite(value.sourceTimestampMs) || value.sourceTimestampMs <= this.sourceTimestampMs || !Number.isFinite(at) || at < this.lastAt) return
    if (this.maximumCpuMs !== null && value.cpuMs < this.maximumCpuMs) return
    this.sourceTimestampMs = value.sourceTimestampMs
    this.samples++
    this.maximumGapMs = Math.max(this.maximumGapMs, at - this.lastAt)
    this.lastAt = at
    this.maximumCpuMs = Math.max(this.maximumCpuMs ?? 0, value.cpuMs)
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes ?? 0, value.memoryBytes)
    this.maximumProcesses = Math.max(this.maximumProcesses ?? 0, value.processes)
  }

  snapshot(endedAt: number) {
    return { schema: 'biometric-package-resources-v1' as const, source: 'host_docker_engine_stats' as const,
      attempts: this.attempts, samples: this.samples, allAttemptsMeasured: this.attempts > 0 && this.samples === this.attempts,
      maximumObservedCpuMs: this.maximumCpuMs, peakObservedMemoryBytes: this.peakMemoryBytes, maximumObservedProcesses: this.maximumProcesses,
      maximumObservationGapMs: Math.max(this.maximumGapMs, endedAt - this.lastAt), elapsedMs: endedAt - this.startedAt,
      exactLifetimeCpu: false, exactPeakMemory: false, memoryIncludesCache: true }
  }
}

export function startResourceMonitor(read: (() => Promise<Observation>) | null, startedAt: number) {
  const observations = new ResourceObservations(startedAt)
  let pending: Promise<void> | null = null
  let stopped = false
  const sample = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      try {
        observations.record(read ? await read() : null, performance.now())
      }
      catch { observations.record(null, performance.now()) }
    })().finally(() => { pending = null })
    return pending
  }
  const timer = setInterval(() => {
    if (!stopped) void sample()
  }, 250)
  return { sample, stop: async () => {
    stopped = true
    clearInterval(timer)
    if (pending) await pending
    return observations.snapshot(performance.now())
  } }
}
