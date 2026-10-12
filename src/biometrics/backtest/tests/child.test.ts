// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dataHash } from '../../algorithms/canonical'
import { runBacktestChild } from '../child'
import { backtestFixture } from './fixtures/backtest'
let directory: string
let worker: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'biometrics-worker-test-'))
  worker = join(directory, 'worker.cjs')
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
})
afterAll(async () => rm(directory, { recursive: true, force: true }))

describe('shipped worker process', () => {
  it('executes a full frozen replay in a child without live dependencies', async () => {
    const progress: number[] = []
    const report = await runBacktestChild(worker, backtestFixture(), { onProgress: completed => progress.push(completed) })
    expect(progress).toEqual([1])
    expect(report).toMatchObject({ version: 'processed-backtest-report-v1', status: 'insufficient_evidence', nights: [{ uniqueObservationCount: 10 }] })
    const dependencies = await readFile(join(directory, 'dependencies.json'), 'utf8')
    expect(dependencies).not.toMatch(/src\/db\/|src\/hardware\/|drizzle-orm|better-sqlite3/)
  })
  it('processes a retained twelve-hour window beyond the configuration hash size limit', async () => {
    const input = backtestFixture()
    const start = input.dataset.snapshot.sessions[0].startMs
    for (const session of input.dataset.snapshot.sessions) {
      session.endMs = start + 43200000
      session.vitals = Array.from({ length: 720 }, (_, id) => ({ id, timestampMs: start + id * 60000, heartRate: 60.1, hrv: 30, breathingRate: 14, processingRunId: null }))
    }
    input.dataset.manifest.splitProtocol.assignments[0].endMs = start + 43200000
    input.job.datasetHash = dataHash(input.dataset)
    expect(await runBacktestChild(worker, input)).toMatchObject({ nights: [{ uniqueObservationCount: 720 }] })
  })

  it('terminates stalled work on time budget and cancellation, including ignored SIGTERM', async () => {
    const stalled = join(directory, 'stalled.cjs')
    await writeFile(stalled, 'process.on(\'SIGTERM\', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)')
    await expect(runBacktestChild(stalled, {}, { timeoutMs: 100 })).rejects.toThrow('time budget')
    const controller = new AbortController()
    const running = runBacktestChild(stalled, {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(running).rejects.toThrow('cancelled')
  })
  it('rejects invalid inputs, malformed output and nonzero worker exits', async () => {
    await expect(runBacktestChild(worker, {})).rejects.toThrow('failed')
    const malformed = join(directory, 'malformed.cjs')
    await writeFile(malformed, 'process.stdin.resume(); process.stdout.write(\'not JSON\\n\')')
    await expect(runBacktestChild(malformed, {})).rejects.toThrow('invalid event')
    await expect(runBacktestChild(worker, {}, { timeoutMs: 0 })).rejects.toThrow('time budget')
  })
})
