import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { rawInspectionSchema } from './raw-catalog'

export const rawSourceNameSchema = z.string().max(255).regex(/^[A-Za-z0-9_.-]+\.RAW\.gz$/)
export const rawScanInputSchema = z.object({ afterName: rawSourceNameSchema.nullable() }).strict()
const inspectionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('inspected'), nextCursor: rawSourceNameSchema, inspection: rawInspectionSchema }).strict(),
  z.object({ status: z.literal('source_unavailable'), nextCursor: rawSourceNameSchema }).strict(),
  z.object({ status: z.literal('archive_unavailable'), nextCursor: z.null() }).strict(),
  z.object({ status: z.literal('complete'), nextCursor: z.null() }).strict(),
])
export interface RawInspectionLocation {
  pythonPath: string
  modulesPath: string
  archiveDirectory: string
}
export const podRawInspectionLocation: RawInspectionLocation = {
  pythonPath: '/opt/sleepypod/modules/piezo-processor/.venv/bin/python',
  modulesPath: '/opt/sleepypod/modules',
  archiveDirectory: '/persistent/biometrics-archive',
}

/** Trusted deployment paths only; callers supply a filename cursor, never code or paths. */
export function runRawInspectionChild(location: RawInspectionLocation, raw: z.input<typeof rawScanInputSchema>, options: {
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<z.infer<typeof inspectionResultSchema>> {
  const input = rawScanInputSchema.parse(raw)
  const timeoutMs = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) throw new Error('Invalid inspection time budget')
  if (options.signal?.aborted) return Promise.reject(new Error('RAW inspection cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn(location.pythonPath, ['-B', '-m', 'common.biometrics.inspection_worker', '--archive-directory', location.archiveDirectory], {
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
    const timeout = setTimeout(() => stop(new Error('RAW inspection exceeded its time budget')), timeoutMs)
    const abort = () => stop(new Error('RAW inspection cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', () => stop(new Error('RAW inspection worker could not start')))
    child.stdin.on('error', () => stop(new Error('RAW inspection input pipe closed')))
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > 16384) stop(new Error('RAW inspection diagnostics exceeded their bound'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > 65536) return stop(new Error('RAW inspection output exceeded its bound'))
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
        const result = inspectionResultSchema.parse(JSON.parse(text))
        if ((result.nextCursor !== null && input.afterName !== null && result.nextCursor <= input.afterName)
          || (result.status === 'inspected' && result.nextCursor !== result.inspection.source_name)) throw new Error('Invalid cursor')
        resolve(result)
      }
      catch { reject(new Error('RAW inspection worker returned an invalid or incomplete result')) }
    })
    child.stdin.end(JSON.stringify({ version: 'raw-inspection-work-v1', after_name: input.afterName }))
  })
}
