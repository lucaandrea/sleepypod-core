import type { evaluateDemoBacktest } from './evaluator'
type Report = ReturnType<typeof evaluateDemoBacktest>
/** Trusted bundled code only. Termination keeps cancellation responsive even
 * during synchronous scoring; no pod connection or hardware path exists. */
export function runDemoEvaluation(input: Parameters<typeof evaluateDemoBacktest>[0], progress: (completed: number, total: number) => void, signal: AbortSignal): Promise<Report> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Demo evaluation cancelled'))
      return
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    let finished = false
    const finish = (error: Error | null, report?: Report) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else if (report) resolve(report)
      else reject(new Error('Missing demo report'))
    }
    const abort = () => finish(new Error('Demo evaluation cancelled'))
    const timeout = setTimeout(() => finish(new Error('Demo evaluation timed out')), 120000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent) => {
      if (finished) return
      const message = event.data
      if (message.type === 'progress') progress(message.completedNights, message.totalNights)
      else if (message.type === 'result') finish(null, message.report)
      else if (message.type === 'error') finish(new Error(message.message))
    }
    worker.onerror = () => finish(new Error('Demo worker failed'))
    worker.onmessageerror = () => finish(new Error('Demo worker response could not be decoded'))
    try {
      worker.postMessage(input)
    }
    catch (error) {
      finish(error instanceof Error ? error : new Error('Demo worker input failed'))
    }
  })
}
