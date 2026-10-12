/** Synthetic-only qualification harness. Bundle with esbuild (better-sqlite3 external).
 * Pass NEW_DIRECTORY MIGRATIONS WORKER [mixed|dense] [COORDINATOR].
 * Omitting COORDINATOR measures the old, synchronous calling-process path.
 * Reads only loopback sensor/API telemetry; never opens the application databases.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import * as schema from '../../src/db/biometrics-schema'
import { DatasetStore } from '../../src/biometrics/backtest/datasets'
import { BacktestJobStore } from '../../src/biometrics/backtest/jobs'
import { runCoordinatorTask } from '../../src/biometrics/backtest/coordinator'
import { executeNextBacktest } from '../../src/biometrics/backtest/runner'
import { workerBuildHash } from '../../src/biometrics/backtest/child'
import { defaultConfig, manifestHash } from '../../src/biometrics/algorithms/registry'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { ReferenceStore } from '../../src/biometrics/references/store'
import { previewReferenceImport } from '../../src/biometrics/references/normalize'

async function main() {
  const [directoryArg, migrationsArg, workerArg, fixture = 'mixed', coordinatorArg] = process.argv.slice(2)
  if (!directoryArg || !migrationsArg || !workerArg) throw new Error('NEW_DIRECTORY MIGRATIONS WORKER required')
  if (!['mixed', 'dense'].includes(fixture)) throw new Error('Fixture must be mixed or dense')
  const dense = fixture === 'dense'
  const directory = resolve(directoryArg)
  // Exclusive creation prevents accidentally benchmarking against an existing DB.
  mkdirSync(directory, { mode: 0o700 })
  const sqlite = new Database(join(directory, 'synthetic.db'))
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve(migrationsArg) })
  const workerPath = resolve(workerArg), evaluatorBuildHash = await workerBuildHash(workerPath)
  const sessionIds: number[] = []
  const references: Array<Record<string, unknown>> = []
  const day = 86400000, start = Date.UTC(2026, 0, 1, 20)
  sqlite.transaction(() => {
    for (let night = 0; night < 20; night++) {
      const from = start + night * day, id = night + 1
      sessionIds.push(id)
      db.insert(schema.sleepRecords).values({ id, side: 'left', enteredBedAt: new Date(from), leftBedAt: new Date(from + 12 * 3600000), sleepDurationSeconds: 43200, timesExitedBed: 0 }).run()
      for (let row = 0; row < (dense ? 950 : 720); row++) {
        db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(from + row * (dense ? 45000 : 60000)), heartRate: row % 47 === 0 ? null : 55 + 12 * Math.sin(row / 30), hrv: 30 + row % 40, breathingRate: 12 + row % 7 }).run()
        if (!dense && row % 4 === 0) db.insert(schema.movement).values({ side: 'left', timestamp: new Date(from + row * (dense ? 45000 : 60000)), totalMovement: row % 32 === 0 ? 250 : row % 60 }).run()
      }
      for (let row = 0; row < (dense ? 20 : 40); row++) {
        const timestampMs = from + row * (dense ? 2160000 : 1080000)
        references.push({ recordKey: `${night}:hr:${row}`, metric: 'heart_rate', value: 58 + row % 12, unit: 'bpm', timestampMs })
        references.push({ recordKey: `${night}:stage:${row}`, metric: 'sleep_stages', value: ['wake', 'light', 'deep', 'rem'][row % 4], unit: 'stage', startMs: timestampMs, endMs: timestampMs + (dense ? 2160000 : 1080000) })
      }
    }
  })()
  const imported = { side: 'left' as const, subjectId: 'synthetic-qualification', source: 'synthetic-v1', rows: references }
  const preview = previewReferenceImport(imported)
  const reference = new ReferenceStore(db).commit({ import: imported, previewHash: preview.summary.contentHash })
  const coordinator = coordinatorArg ? { databasePath: join(directory, 'synthetic.db'), coordinatorPath: resolve(coordinatorArg), workerPath, modulePath: process.env.NODE_PATH } : null
  const snapshotHistogram = monitorEventLoopDelay({ resolution: 20 })
  snapshotHistogram.enable()
  await new Promise(resolve => setTimeout(resolve, 50))
  const snapshotStart = performance.now()
  const datasetInput = { side: 'left' as const, subjectId: imported.subjectId, sessionIds, referenceImportIds: [reference.id], timezone: 'UTC', idempotencyKey: 'synthetic-v1' }
  const dataset = coordinator ? await runCoordinatorTask(coordinator, { type: 'createDataset', input: datasetInput }) : new DatasetStore(db).create(datasetInput)
  const snapshotMs = performance.now() - snapshotStart
  await new Promise(resolve => setTimeout(resolve, 50))
  const snapshotEventLoopMaxMs = snapshotHistogram.max / 1e6
  snapshotHistogram.disable()
  const originalHash = () => createHash('sha256').update(JSON.stringify(sqlite.prepare('SELECT * FROM vitals ORDER BY id').all())).digest('hex')
  const beforeHash = originalHash()
  const jobs = new BacktestJobStore(db)
  const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'stage_replay' as const, assumedStageCalibrationQuality: 1, pointToleranceMs: 30000, clockOffsetMs: 0 }
  const experiment = coordinator ? await runCoordinatorTask(coordinator, { type: 'createExperiment', input: { datasetId: dataset.id, protocol, idempotencyKey: 'synthetic-experiment' } }) : jobs.createExperiment(dataset.id, protocol)
  const configs = (['default', 'current', 'candidate'] as const).map((label, index) => {
    const resolved = structuredClone(defaultConfig)
    // Synthetic comparison roles: this benchmark tests resources, not promotion.
    resolved.sleep_stages.ruleset.rules[1].when[0].value = 0.90 + index * 0.02
    return { label, revisionId: null, manifestHash, resolvedHash: configHash(resolved), resolved }
  })
  let phase = 'baseline', stopped = false, piezoAt: number | null = null, piezoSourceAt: number | null = null
  const samples: unknown[] = [], runs: unknown[] = []
  const socket = new WebSocket('ws://127.0.0.1:3001')
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', sensors: ['piezo-dual'] })))
  socket.on('error', () => {})
  socket.on('message', (bytes) => {
    try {
      const frame = JSON.parse(bytes.toString())
      if (frame.type === 'piezo-dual') {
        piezoAt = Date.now()
        piezoSourceAt = typeof frame.ts === 'number' ? frame.ts * 1000 : null
      }
    }
    catch { /* No frame contents are retained. */ }
  })
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const sampler = (async () => {
    while (!stopped) {
      const sample: Record<string, unknown> = { phase, atMs: Date.now(), parentRss: process.memoryUsage().rss, piezoAgeMs: piezoAt === null ? null : Date.now() - piezoAt, piezoSourceAgeMs: piezoSourceAt === null ? null : Date.now() - piezoSourceAt }
      sample.memAvailableKiB = Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1])
      sample.temperatureC = Number(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000
      for (const path of ['health/performance', 'device/status']) {
        const began = performance.now()
        try {
          const response = await fetch(`http://127.0.0.1:3000/api/${path}`, { signal: AbortSignal.timeout(2000) })
          await response.arrayBuffer()
          sample[path] = { ms: performance.now() - began, status: response.status }
        }
        catch { sample[path] = { failed: true, ms: performance.now() - began } }
      }
      samples.push(sample)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  })()
  try {
    await new Promise(resolve => setTimeout(resolve, 4000))
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = jobs.enqueue({ evaluatorBuildHash, experimentId: experiment.id, configs, split: 'tuning', idempotencyKey: `run-${attempt}` })
      phase = `replay-${attempt}`
      histogram.reset()
      const began = performance.now()
      const outcome = coordinator
        ? await runCoordinatorTask(coordinator, { type: 'execute', owner: 'synthetic-qualification' }, { admit: async () => true })
        : await executeNextBacktest(db, { owner: 'synthetic-qualification', workerPath, admit: async () => true, timeoutMs: 120000 })
      const elapsedMs = performance.now() - began
      // Let timers observe the final synchronous publication before reading delay.
      await new Promise(resolve => setTimeout(resolve, 50))
      const readStarted = performance.now(), result = coordinator ? await runCoordinatorTask(coordinator, { type: 'readResult', input: { id: job.id } }) : jobs.result(job.id)
      const resultReadMs = performance.now() - readStarted
      const report = result?.report as { operational?: unknown } | undefined
      const reportBytes = Buffer.byteLength(JSON.stringify(report ?? null))
      // Include IPC deserialization and report serialization in the calling-loop maximum.
      await new Promise(resolve => setTimeout(resolve, 50))
      runs.push({ outcome, elapsedMs, resultReadMs, available: result?.available, reportBytes, operational: report?.operational,
        parentEventLoopP95Ms: histogram.percentile(95) / 1e6, parentEventLoopMaxMs: histogram.max / 1e6, parentPeakRssKiB: process.resourceUsage().maxRSS })
      if (outcome.state !== 'succeeded') throw new Error(`Qualification run failed: ${jobs.get(job.id).error}`)
    }
    phase = 'after'
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  finally {
    stopped = true
    await sampler
    socket.terminate()
    histogram.disable()
    const output = { version: 'synthetic-runner-qualification-v1', fixture, coordinator: coordinator !== null, evaluatorBuildHash, datasetHash: dataset.contentHash, snapshotMs, snapshotEventLoopMaxMs,
      canonicalObservationsUnchanged: beforeHash === originalHash(), runs, samples }
    writeFileSync(join(directory, 'measurements.json'), JSON.stringify(output, null, 2))
    sqlite.close()
    console.log(JSON.stringify({ directory, evaluatorBuildHash, runs, canonicalObservationsUnchanged: output.canonicalObservationsUnchanged }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
