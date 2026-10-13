import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { z } from 'zod'

const resultSchema = z.object({ version: z.literal('raw-collection-result-v1'), released: z.number().int().min(0).max(10000), orphans: z.number().int().min(0).max(10000) }).strict()
interface RawCollectionLocation { pythonPath: string, modulesPath: string, databasePath: string, retainedDirectory: string }

/** Trusted deployment paths only; no RPC arguments select files or alter retention grace. */
export function runRawCollectionChild(location: RawCollectionLocation, options: {
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<z.infer<typeof resultSchema>> {
  const timeoutMs = options.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) throw new Error('Invalid collection time budget')
  if (options.signal?.aborted) return Promise.reject(new Error('RAW collection cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn(location.pythonPath, ['-B', '-m', 'common.biometrics.collection_worker', '--database-path', location.databasePath, '--retained-directory', location.retainedDirectory], {
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
    const timeout = setTimeout(() => stop(new Error('RAW collection exceeded its time budget')), timeoutMs)
    const abort = () => stop(new Error('RAW collection cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', () => stop(new Error('RAW collection worker could not start')))
    child.stdin.on('error', () => stop(new Error('RAW collection input pipe closed')))
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > 16384) stop(new Error('RAW collection diagnostics exceeded their bound'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > 1024) return stop(new Error('RAW collection output exceeded its bound'))
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
        const result = resultSchema.parse(JSON.parse(text))
        resolve(result)
      }
      catch { reject(new Error('RAW collection worker returned an invalid or incomplete result')) }
    })
    child.stdin.end(JSON.stringify({ version: 'raw-collection-work-v1' }))
  })
}
