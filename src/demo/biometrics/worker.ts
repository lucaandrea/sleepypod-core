import { evaluateDemoBacktest } from './evaluator'
self.onmessage = (event: MessageEvent<Parameters<typeof evaluateDemoBacktest>[0]>) => {
  try {
    const report = evaluateDemoBacktest(event.data, (completedNights, totalNights) => self.postMessage({ type: 'progress', completedNights, totalNights }))
    self.postMessage({ type: 'result', report })
  }
  catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Demo evaluation failed' })
  }
}
