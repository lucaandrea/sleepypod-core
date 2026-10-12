import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const side = z.enum(['left', 'right'])
const value = z.number().finite().nullable()
const limitations = z.array(z.string().max(200)).max(40)
export const waveformReadingSchema = z.object({
  side, timestampMs: count, heartRate: value, hrvIndex: value,
  hrvMetric: z.literal('window_ibi_variability_v1'), breathingRate: value,
  qualityScore: z.number().finite(), flags: z.array(z.string().max(200)).max(40).nullable(), hrRaw: value,
  sourceSide: side, configHash: hash, limitations,
}).strict()
export const waveformRunSchema = z.object({
  version: z.literal('retained-waveform-run-v1'), decoded_records: count, raw_records: count,
  counts: z.object({ records: count, accepted_frames: count, empty_channel_frames: count,
    pump_gated_frames: count, preroll_outputs: count, scored_outputs: count }).strict(),
  limitations, config_hashes: z.object({ left: hash, right: hash }).strict(), artifact_hashes: z.array(hash).min(1).max(64),
}).strict()
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reading'), reading: waveformReadingSchema }).strict(),
  z.object({ type: z.literal('result'), result: waveformRunSchema }).strict(),
])
export interface WaveformWorkerLocation {
  pythonPath: string
  modulesPath: string
  retainedDirectory: string
}

/** Locations are trusted server configuration, never fields accepted by RPC. */
export function runWaveformChild(location: WaveformWorkerLocation, work: unknown, options: {
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<{ readings: z.infer<typeof waveformReadingSchema>[], run: z.infer<typeof waveformRunSchema> }> {
  const serialized = JSON.stringify(work)
  if (!serialized || Buffer.byteLength(serialized) > 8 * 1024 * 1024) return Promise.reject(new Error('Waveform input exceeds 8 MiB'))
  const timeoutMs = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 1800000) return Promise.reject(new Error('Invalid waveform time budget'))
  if (options.signal?.aborted) return Promise.reject(new Error('Waveform replay cancelled'))
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(location.pythonPath, ['-B', '-m', 'common.biometrics.replay_worker', '--retained-directory', location.retainedDirectory], {
      cwd: tmpdir(), env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC',
        OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const readings: z.infer<typeof waveformReadingSchema>[] = []
    let result: z.infer<typeof waveformRunSchema> | undefined
    const decoder = new StringDecoder('utf8')
    let pending = '', outputBytes = 0, diagnosticBytes = 0
    let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500)
    }
    const timeout = setTimeout(() => stop(new Error('Waveform replay exceeded its time budget')), timeoutMs)
    const abort = () => stop(new Error('Waveform replay cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', () => stop(new Error('Waveform worker could not start')))
    child.stdin.on('error', () => stop(new Error('Waveform worker input pipe closed')))
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > 16384) stop(new Error('Waveform diagnostic output exceeded its bound'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > 16 * 1024 * 1024) return stop(new Error('Waveform output exceeds 16 MiB'))
      pending += decoder.write(chunk)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        try {
          if (result || Buffer.byteLength(line) > 65536) throw new Error('Invalid event order or length')
          const event = eventSchema.parse(JSON.parse(line))
          if (event.type === 'reading') {
            if (readings.length >= 20000) throw new Error('Too many waveform readings')
            readings.push(event.reading)
          }
          else result = event.result
        }
        catch {
          stop(new Error('Waveform worker emitted an invalid event'))
          return
        }
      }
      if (Buffer.byteLength(pending) > 65536) stop(new Error('Waveform event exceeds its byte bound'))
    })
    child.on('close', (code) => {
      pending += decoder.end()
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || !result || pending.length || result.counts.scored_outputs !== readings.length
        || result.raw_records < result.decoded_records || result.decoded_records < result.counts.records
        || readings.some(reading => reading.configHash !== result?.config_hashes[reading.side])) {
        reject(new Error('Waveform worker failed or returned an incomplete result'))
      }
      else resolve({ readings, run: result })
    })
    child.stdin.end(serialized)
  })
}
