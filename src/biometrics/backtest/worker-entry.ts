import { evaluateBacktest } from './evaluator'

// Shipped evaluator only. This process is not an untrusted-code sandbox.
const MAX_INPUT = 10 * 1024 * 1024
let received = 0
const chunks: Buffer[] = []
process.stdin.on('data', (chunk: Buffer) => {
  received += chunk.length
  if (received > MAX_INPUT) {
    process.stderr.write('Replay input exceeds the worker byte limit\n')
    process.exit(2)
  }
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  try {
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    // Parsing at the boundary is performed again by the shared contract.
    const started = performance.now()
    const report = evaluateBacktest(input as Parameters<typeof evaluateBacktest>[0], (completedNights, totalNights) => {
      process.stdout.write(`${JSON.stringify({ type: 'progress', completedNights, totalNights })}\n`)
    })
    process.stdout.write(`${JSON.stringify({ type: 'result', report: { ...report, operational: { runtimeMs: performance.now() - started, peakRssKiB: process.resourceUsage().maxRSS, heapLimitMiB: 128 } } })}\n`)
  }
  catch {
    // Input exports and annotations are health data, not diagnostic log text.
    process.stderr.write('Replay failed input validation or evaluation\n')
    process.exitCode = 1
  }
})
