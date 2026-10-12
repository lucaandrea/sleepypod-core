import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { tmpdir, setPriority } from 'node:os'
import { z } from 'zod'

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), completedNights: z.number().int().min(0).max(60), totalNights: z.number().int().min(0).max(60) }).strict(),
  z.object({ type: z.literal('result'), report: z.object({ version: z.enum(['processed-backtest-report-v1', 'waveform-backtest-report-v1']) }).passthrough() }).strict(),
])

export async function workerBuildHash(workerPath: string) {
  return createHash('sha256').update(await readFile(workerPath)).digest('hex')
}

/** Executes only the shipped worker path selected by the server, never uploads. */
export function runBacktestChild(workerPath: string, input: unknown, options: {
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (completed: number, total: number) => void
} = {}): Promise<unknown> {
  const serialized = JSON.stringify(input)
  if (!serialized || Buffer.byteLength(serialized) > 10 * 1024 * 1024) return Promise.reject(new Error('Replay input exceeds 10 MiB'))
  const timeoutMs = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 1800000) return Promise.reject(new Error('Invalid replay time budget'))
  if (options.signal?.aborted) return Promise.reject(new Error('Replay cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', workerPath], {
      cwd: tmpdir(), env: { NODE_ENV: 'production', LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const decoder = new StringDecoder('utf8')
    let stdout = '', outputBytes = 0, stderrBytes = 0
    let result: unknown, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500)
    }
    if (child.pid) {
      try {
        setPriority(child.pid, 19)
      }
      catch {
        stop(new Error('Could not lower replay process priority'))
      }
    }
    const timeout = setTimeout(() => stop(new Error('Replay exceeded its time budget')), timeoutMs)
    const abort = () => stop(new Error('Replay cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => stop(error))
    child.stdin.on('error', () => stop(new Error('Replay input pipe closed')))
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      // Do not retain or log health exports through a worker error channel.
      if (stderrBytes > 16384) stop(new Error('Replay diagnostic output exceeded its bound'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > 16 * 1024 * 1024) return stop(new Error('Replay output exceeded 16 MiB'))
      stdout += decoder.write(chunk)
      let newline: number
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        try {
          const event = eventSchema.parse(JSON.parse(line))
          if (result !== undefined) throw new Error('Worker emitted data after its result')
          if (event.type === 'progress') options.onProgress?.(event.completedNights, event.totalNights)
          else result = event.report
        }
        catch {
          stop(new Error('Replay emitted an invalid event or progress update'))
          return
        }
      }
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || result === undefined || stdout.length) reject(new Error('Replay worker failed or returned an incomplete report'))
      else resolve(result)
    })
    child.stdin.end(serialized)
  })
}
