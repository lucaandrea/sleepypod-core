import { replayBudgetSchema } from '../../src/biometrics/backtest/execution-budget'
/** Synthetic-only hardware qualification. Arguments:
 * NEW_DIRECTORY MIGRATIONS WORKER COORDINATOR PYTHON MODULES FIXTURE_JSON ARCHIVES
 * Opens only its newly created DB; live telemetry is read-only and bodies are discarded.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setPriority, loadavg, availableParallelism } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { z } from 'zod'
import * as schema from '../../src/db/biometrics-schema'
import { CoordinatorQueue } from '../../src/biometrics/backtest/coordinator-queue'
import { BacktestJobStore } from '../../src/biometrics/backtest/jobs'
import { datasetManifestSchema } from '../../src/biometrics/backtest/contracts'
import { RawSourceCatalog, rawInspectionSchema } from '../../src/biometrics/backtest/raw-catalog'
import { waveformEvaluatorBuildIdentity } from '../../src/biometrics/backtest/waveform-build'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { defaultConfig, manifestHash } from '../../src/biometrics/algorithms/registry'
import { collectAdmissionSample } from '../../src/biometrics/backtest/admission'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 8) throw new Error('NEW_DIRECTORY MIGRATIONS WORKER COORDINATOR PYTHON MODULES FIXTURE_JSON ARCHIVES required')
  const [directory, migrations, workerPath, coordinatorPath, pythonPath, modulesPath, fixturePath, archiveDirectory] = args.map(value => resolve(value))
  const fixture = z.object({ version: z.literal('synthetic-waveform-fixture-v1'), startMs: z.number(), endMs: z.number(), seconds: z.number(),
    generationSeconds: z.number(), inspections: z.array(rawInspectionSchema).min(1).max(4) }).strict().parse(JSON.parse(readFileSync(fixturePath, 'utf8')))
  mkdirSync(directory, { mode: 0o700 })
  setPriority(process.pid, 19)
  const sqlite = new Database(join(directory, 'synthetic.db'))
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: migrations })
  const replayBudget = process.env.SLEEPYPOD_BIOMETRICS_REPLAY_BUDGET === undefined
    ? undefined
    : replayBudgetSchema.parse(JSON.parse(process.env.SLEEPYPOD_BIOMETRICS_REPLAY_BUDGET))
  const options = { replayBudget, databasePath: join(directory, 'synthetic.db'), workerPath, coordinatorPath,
    modulePath: process.env.NODE_PATH, rawLocation: { pythonPath, modulesPath, archiveDirectory } }
  const coordinator = new CoordinatorQueue(options)
  let retainedDatasetId: string | undefined
  const start = fixture.startMs + 300000
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(fixture.endMs),
    sleepDurationSeconds: (fixture.endMs - start) / 1000, timesExitedBed: 0, presentIntervals: [[start / 1000, fixture.endMs / 1000]] }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start), heartRate: 65 }).run()
  const originalRows = JSON.stringify(sqlite.prepare('SELECT * FROM vitals').all())
  const sources = fixture.inspections.map(inspection => new RawSourceCatalog(db).record(inspection))
  let phase = 'baseline', stopped = false, piezoAt: number | undefined
  let completed = false, readFailures = 0
  const samples: unknown[] = [], operations: unknown[] = []
  let lastHttpHealthy = false
  const socket = new WebSocket('ws://127.0.0.1:3001')
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', sensors: ['piezo-dual'] })))
  socket.on('error', () => {})
  socket.on('message', (bytes) => {
    try {
      if (JSON.parse(bytes.toString()).type === 'piezo-dual') piezoAt = Date.now()
    }
    catch { /* Never retain sensor payloads. */ }
  })
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const sampler = (async () => {
    while (!stopped) {
      const sample = await collectAdmissionSample(directory, () => piezoAt)
      const requests = []
      for (const endpoint of ['health/performance', 'device/status']) {
        const began = performance.now()
        try {
          const response = await fetch(`http://127.0.0.1:3000/api/${endpoint}`, { signal: AbortSignal.timeout(1500) })
          await response.arrayBuffer()
          requests.push({ endpoint, status: response.status, ms: performance.now() - began })
        }
        catch { requests.push({ endpoint, status: 0, ms: performance.now() - began }) }
      }
      let concurrentReadMs: number | undefined
      if (phase === 'waveform-replay' && retainedDatasetId && samples.length % 10 === 0) {
        const began = performance.now()
        try {
          await coordinator.request({ type: 'datasetDescriptor', input: { id: retainedDatasetId } })
        }
        catch { readFailures++ }
        concurrentReadMs = performance.now() - began
      }
      lastHttpHealthy = readFailures === 0 && requests.every(row => row.status === 200 && row.ms < 1000)
      samples.push({ phase, sample, requests, concurrentReadMs, parentRss: process.memoryUsage().rss, loadPerCpu: loadavg()[0] / availableParallelism() })
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  })()
  // Conservative stop conditions for measurement, not a production qualification policy.
  const admit = async () => {
    const sample = await collectAdmissionSample(directory, () => piezoAt)
    return sample !== null && lastHttpHealthy && sample.availableMemoryBytes >= 512 * 1024 * 1024
      && sample.freeDiskBytes >= 1024 * 1024 * 1024 && sample.temperatureC <= 65
      && Date.now() - sample.piezoReceivedAtMs <= 10000 && sample.eventLoopDelayMs <= 100
  }
  async function measure<T>(name: string, action: () => Promise<T>) {
    phase = name
    histogram.reset()
    const began = performance.now()
    let succeeded = false
    try {
      const result = await action()
      succeeded = true
      return result
    }
    finally {
      await new Promise(resolve => setTimeout(resolve, 50))
      operations.push({ phase, succeeded, elapsedMs: performance.now() - began, eventLoopP95Ms: histogram.percentile(95) / 1e6,
        eventLoopMaxMs: histogram.max / 1e6, parentPeakRssKiB: process.resourceUsage().maxRSS })
    }
  }
  try {
    await new Promise(resolve => setTimeout(resolve, 8000))
    if (!await admit()) throw new Error('Live health is unavailable or outside conservative benchmark limits')
    const parent = await measure('snapshot', () => coordinator.request({ type: 'createDataset', input: { side: 'left', subjectId: 'synthetic',
      sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'synthetic-parent' } }))
    const published = await measure('retain', () => coordinator.request({ type: 'createWaveformDataset', input: {
      parentDatasetId: parent.id, expectedContentHash: parent.contentHash, idempotencyKey: 'synthetic-waveform',
      cohorts: datasetManifestSchema.parse(parent.manifest).splitProtocol.assignments.map(cohort => ({ cohortId: cohort.cohortId, sourceIds: sources })),
    } }, { admit }))
    if (published.status !== 'published') throw new Error('Waveform retention was deferred')
    retainedDatasetId = published.dataset.id
    const build = await waveformEvaluatorBuildIdentity(coordinatorPath, workerPath, options.rawLocation)
    const jobs = new BacktestJobStore(db)
    const experiment = jobs.createExperiment(published.dataset.id, { version: 'descriptive-evaluation-v1', mode: 'signal_replay', waveformStages: true,
      assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 })
    const configs = (['default', 'current', 'candidate'] as const).map((label, index) => {
      const resolved = structuredClone(defaultConfig)
      resolved.heart_rate.trackingToleranceBpm = 15 + index * 2
      return { label, revisionId: null, manifestHash, resolvedHash: configHash(resolved), resolved }
    })
    const job = jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: build.hash, idempotencyKey: 'synthetic-signal', split: 'tuning', configs,
      waveform: { pythonBuildHash: build.python.hash, otherSide: { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig } } })
    await measure('waveform-replay', async () => {
      const outcome = await coordinator.request({ type: 'execute', owner: 'synthetic-qualification' }, { admit })
      if (outcome.state !== 'succeeded') throw new Error(`Waveform job stopped: ${jobs.get(job.id).error}`)
    })
    const summary = await measure('summary', () => coordinator.request({ type: 'readSummary', input: { id: job.id } }))
    if (!summary?.available || !summary.contentHash) throw new Error('Committed report summary unavailable')
    const report = z.object({ version: z.literal('waveform-backtest-report-v1'), datasetHash: z.string(),
      waveform: z.object({ outputs: z.array(z.object({ configHash: z.string(), run: z.object({ build_hash: z.string(),
        counts: z.object({ scored_outputs: z.number().int().positive() }) }) })).length(3) }),
    }).parse(summary.report)
    if (report.datasetHash !== published.dataset.contentHash
      || new Set(report.waveform.outputs.map(output => output.configHash)).size !== 3
      || report.waveform.outputs.some(output => output.run.build_hash !== build.python.hash || !configs.some(config => config.resolvedHash === output.configHash))) {
      throw new Error('Qualification report identity or configuration coverage mismatch')
    }
    operations.push({ summaryBytes: Buffer.byteLength(JSON.stringify(summary)), resultHash: summary?.contentHash,
      compoundBuildHash: build.hash, pythonBuildHash: build.python.hash })
    if (readFailures) throw new Error('Concurrent dataset reads failed')
    completed = true
    phase = 'after'
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  finally {
    stopped = true
    await sampler
    await coordinator.stop()
    socket.terminate()
    histogram.disable()
    const output = { version: 'synthetic-waveform-qualification-v1', completed, readFailures, replayBudget: replayBudget ?? null, fixtureSeconds: fixture.seconds, compressedBytes: fixture.inspections.reduce((sum, row) => sum + row.artifact.compressed_bytes, 0),
      canonicalObservationsUnchanged: originalRows === JSON.stringify(sqlite.prepare('SELECT * FROM vitals').all()), operations, samples }
    writeFileSync(join(directory, 'measurements.json'), JSON.stringify(output, null, 2), { mode: 0o600 })
    sqlite.close()
    console.log(JSON.stringify({ directory, ...output, samples: output.samples.length }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
