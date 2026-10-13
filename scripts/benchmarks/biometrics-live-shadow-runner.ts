/** Operational measurement only; never installs a qualification or changes profiles.
 * Run on the pod: STAGE APP_ROOT PYTHON MODULES DATA_DIR [SECONDS=180]
 * Live frames stay on the pod. Only summary metadata may be exported afterward.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { defaultConfig, manifestHash } from '../../src/biometrics/algorithms/registry'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { ShadowStore } from '../../src/biometrics/shadow/store'
import { runShadowAttempt } from '../../src/biometrics/shadow/attempt'
import { plannedShadowSourceFactory } from '../../src/biometrics/shadow/planned-sources'
import { startShadowHealthMonitor } from '../../src/biometrics/shadow/health-monitor'
import { collectAdmissionSample, evaluateAdmission, type AdmissionSample } from '../../src/biometrics/backtest/admission'
import { probeShadowBuild } from '../../src/biometrics/shadow/build'
import { publishProspectiveFrame, failProspectiveFrames } from '../../src/streaming/prospectiveFrameTap'

async function main() {
  const [stage, app, pythonPath, modulesPath, data, rawSeconds = '180'] = process.argv.slice(2)
  const seconds = Number(rawSeconds)
  if (!stage || !app || !pythonPath || !modulesPath || !data || !Number.isInteger(seconds) || seconds < 150 || seconds > 600) throw new Error('Invalid measurement arguments')
  const directory = await mkdtemp(join(stage, 'live-shadow-'))
  const configurationDatabase = join(data, 'sleepypod.db'), biometricsDatabase = join(data, 'biometrics.db')
  const configuration = new Database(configurationDatabase, { readonly: true, fileMustExist: true, timeout: 100 })
  const sink = new Database(join(directory, 'isolated.db'))
  sink.pragma('journal_mode = WAL')
  migrate(drizzle(sink), { migrationsFolder: join(app, 'src/db/biometrics-migrations') })
  const controller = new AbortController(), socket = new WebSocket('ws://127.0.0.1:3001', { maxPayload: 128 * 1024 })
  let piezoAt: number | undefined, received = 0, closed = false
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', sensors: ['piezo-dual', 'frzHealth'] })))
  socket.on('message', (bytes) => {
    try {
      const frame = JSON.parse(bytes.toString())
      if (!['piezo-dual', 'frzHealth'].includes(frame.type)) return
      const now = Date.now()
      if (frame.type === 'piezo-dual') piezoAt = now
      received++
      publishProspectiveFrame(frame, false, now)
    }
    catch {
      controller.abort()
      failProspectiveFrames()
    }
  })
  socket.on('error', () => {
    controller.abort()
    failProspectiveFrames()
  })
  socket.on('close', () => {
    if (!closed) {
      controller.abort()
      failProspectiveFrames()
    }
  })
  let monitor: Awaited<ReturnType<typeof startShadowHealthMonitor>> | undefined
  let runId: string | undefined, result: unknown = null, failure: string | null = null
  let lastHealth: AdmissionSample | null = null, refusal: unknown = null
  const store = new ShadowStore(sink, { maximumRuns: 1, maximumPoints: 2000, maximumBytes: 8 * 1024 * 1024 })
  try {
    const deadline = Date.now() + 30000
    while (!piezoAt && Date.now() < deadline && !controller.signal.aborted) await delay(100)
    if (!piezoAt || controller.signal.aborted) throw new Error('No live piezo stream')
    const assertDefaults = () => {
      if (!configuration.readonly || (configuration.prepare('SELECT count(*) AS count FROM biometric_profile_bindings').get() as { count: number }).count !== 0) throw new Error('Measurement requires unchanged unpersonalized defaults')
    }
    assertDefaults()
    const policy = { qualificationId: 'live-shadow-operational-measurement-only', minimumAvailableMemoryBytes: 768 * 1024 * 1024,
      minimumFreeDiskBytes: 2 * 1024 * 1024 * 1024, maximumLoadPerCpu: 1.1, maximumEventLoopDelayMs: 100,
      maximumPiezoAgeMs: 5000, maximumTemperatureC: 55, maximumSampleAgeMs: 2000 }
    monitor = await startShadowHealthMonitor(async () => {
      lastHealth = await collectAdmissionSample(directory, () => piezoAt)
      return lastHealth
    }, policy, controller.signal)
    const hash = configHash(defaultConfig), python = await probeShadowBuild({ pythonPath, modulesPath })
    const runnerHash = createHash('sha256').update(await readFile(process.argv[1])).digest('hex')
    const startMs = Date.now() + 2000, endMs = startMs + seconds * 1000
    const plan = { schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'local-operational-measurement', startMs, endMs,
      candidateConfigHash: hash, activeConfigHash: hash, qualificationHash: dataHash(policy), engineBuildHash: dataHash({ runnerHash, python: python.hash }),
      maximumPoints: 2000, maximumBytes: 8 * 1024 * 1024, metrics: ['heart_rate'],
      joining: { maximumPendingPoints: 200, maximumLatenessMs: 60000, drainGraceMs: 65000 },
      monitoring: { expectedIntervalMs: 60000, maximumGapMs: 120000, heartbeatStaleMs: 2000, minimumCandidateCoverage: 0.01,
        maximumCoverageLoss: 1, minimumQuality: 0, alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } },
      execution: { version: 'shadow-execution-policy-v1', configHashes: { left: hash, right: hash }, maximumRecords: 10000, maximumOutputs: 2000,
        maximumCpuMs: 120000, maximumInputBytes: 64 * 1024 * 1024, maximumOutputBytes: 8 * 1024 * 1024,
        budgets: { cpuSeconds: 120, addressSpaceBytes: 768 * 1024 * 1024, maximumRssBytes: 384 * 1024 * 1024,
          wallMs: (seconds + 90) * 1000, acknowledgmentMs: 30000, idleMs: 10000, rssIntervalMs: 100, rssTimeoutMs: 1000 },
        leaseMs: 5000, heartbeatMs: 500, sources: { pollMs: 500, maximumActiveRows: 100, databaseBusyTimeoutMs: 100,
          frames: { maximumFrames: 30, maximumBytes: 4 * 1024 * 1024, maximumEventAgeMs: 10000, maximumFutureSkewMs: 1000 },
          context: { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 65536 } } } }
    const created = store.create(plan, 'measurement'), openSources = plannedShadowSourceFactory(plan,
      { configurationDatabase, biometricsDatabase, presenceFile: join(data, 'sleep-detector-state.json') })
    runId = created.id
    await delay(Math.max(0, startMs - Date.now()))
    const attempt = await runShadowAttempt(store, runId, { location: { pythonPath, modulesPath },
      configs: { left: defaultConfig, right: defaultConfig }, openSources, admit: () => {
        assertDefaults()
        if (!monitor?.read()) {
          refusal = { checkedAtMs: Date.now(), sample: lastHealth, decision: evaluateAdmission(lastHealth, policy) }
          throw new Error('Measurement health admission refused')
        }
      } }, controller.signal)
    result = { runnerHash, pythonBuildHash: python.hash, manifestHash, receipt: attempt.receipt }
  }
  catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  }
  finally {
    closed = true
    controller.abort()
    monitor?.close()
    socket.terminate()
    const run = runId ? store.get(runId) : null
    const canonicalRows = (sink.prepare('SELECT count(*) AS count FROM vitals').get() as { count: number }).count
    await writeFile(join(stage, 'live-shadow-summary.json'), JSON.stringify({
      version: 'live-shadow-operational-measurement-v1', scope: 'loopback live input and read-only active observations with isolated sink; not production registry admission or accuracy qualification',
      seconds, receivedFrames: received, state: run?.state ?? null, reason: run?.reason ?? null,
      pointCount: run?.point_count ?? 0, byteCount: run?.byte_count ?? 0, canonicalRowsInIsolatedSink: canonicalRows,
      result, failure, refusal, workerReceipt: run?.workerReceipt ?? null,
    }, null, 2))
    configuration.close()
    sink.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
