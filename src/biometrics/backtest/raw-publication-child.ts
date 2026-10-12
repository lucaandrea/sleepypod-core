import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { RawInspectionLocation } from './raw-inspection-child'
import type { prepareSelectedWaveformDataset } from './waveform-selection'

const publicationResultSchema = z.object({ type: z.literal('result'), id: z.string().uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), available: z.boolean() }).strict()
export interface RawPublicationLocation extends RawInspectionLocation {
  databasePath: string
  retainedDirectory: string
}

/** Only coordinator-prepared rows enter this fixed shipped module. No RPC paths or code. */
export function runRawPublicationChild(location: RawPublicationLocation, work: ReturnType<typeof prepareSelectedWaveformDataset>, options: {
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<z.infer<typeof publicationResultSchema>> {
  const serialized = JSON.stringify({ version: 'waveform-publication-work-v1', ...work })
  if (Buffer.byteLength(serialized) > 10 * 1024 * 1024) return Promise.reject(new Error('Waveform publication input exceeds 10 MiB'))
  const timeoutMs = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) throw new Error('Invalid publication time budget')
  if (options.signal?.aborted) return Promise.reject(new Error('Waveform publication cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn(location.pythonPath, ['-B', '-m', 'common.biometrics.publication_worker', '--database', location.databasePath, '--archive-directory', location.archiveDirectory, '--retained-directory', location.retainedDirectory], {
      cwd: tmpdir(), env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC',
        OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let outputBytes = 0, diagnosticBytes = 0
    let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500)
    }
    const timeout = setTimeout(() => stop(new Error('Waveform publication exceeded its time budget')), timeoutMs)
    const abort = () => stop(new Error('Waveform publication cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', () => stop(new Error('Waveform publication worker could not start')))
    child.stdin.on('error', () => stop(new Error('Waveform publication input pipe closed')))
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > 16384) stop(new Error('Waveform publication diagnostics exceeded their bound'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > 65536) return stop(new Error('Waveform publication output exceeded its bound'))
      chunks.push(chunk)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) return reject(failure)
      try {
        if (code !== 0) throw new Error('Worker failed')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        const result = publicationResultSchema.parse(JSON.parse(text))
        if (result.contentHash !== work.prepared.contentHash) throw new Error('Mismatched published dataset')
        resolve(result)
      }
      catch { reject(new Error('Waveform publication worker returned an invalid or incomplete result')) }
    })
    child.stdin.end(serialized)
  })
}
