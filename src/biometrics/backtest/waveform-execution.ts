import type { ReplayBudget } from './execution-budget'
import { sql } from 'drizzle-orm'
import { dirname, join } from 'node:path'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { z } from 'zod'
import type * as schema from '@/src/db/biometrics-schema'
import { dataHash } from '../algorithms/canonical'
import type { backtestWorkSchema } from './evaluator'
import { waveformEvaluationSchema } from './evaluator'
import { datasetManifestSchema } from './contracts'
import { podRawInspectionLocation, type RawInspectionLocation } from './raw-inspection-child'
import { waveformEvaluatorBuildIdentity } from './waveform-build'
import { runWaveformChild } from './waveform-child'

export async function verifyWaveformJobBuild(work: z.infer<typeof backtestWorkSchema>, options: {
  workerPath: string
  rawLocation?: RawInspectionLocation
  signal: AbortSignal
}) {
  const build = await waveformEvaluatorBuildIdentity(join(dirname(options.workerPath), 'coordinator.cjs'), options.workerPath,
    options.rawLocation ?? podRawInspectionLocation, options.signal)
  if (build.hash !== work.job.evaluatorBuildHash || build.python.hash !== work.job.waveform?.pythonBuildHash) throw new Error('Waveform worker build changed since enqueue')
}

/** Run one cohort/configuration at a time. Raw bytes stay in Python; only
 * bounded derived rows reach the isolated Node scorer and retained report. */
export async function executeWaveformInputs(db: BetterSQLite3Database<typeof schema>, work: z.infer<typeof backtestWorkSchema>, options: {
  workerPath: string
  rawLocation?: RawInspectionLocation
  signal: AbortSignal
  timeoutMs?: number
  replayBudget?: ReplayBudget
}) {
  const { job, dataset } = work
  if (job.protocol.mode !== 'signal_replay' || !job.waveform || dataset.snapshot.version !== 'waveform-dataset-v1') throw new Error('Missing retained waveform job inputs')
  const databasePath = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
  if (!databasePath) throw new Error('Waveform execution requires a persistent database')
  const location = { ...(options.rawLocation ?? podRawInspectionLocation), retainedDirectory: join(dirname(databasePath), 'biometric-raw') }
  await verifyWaveformJobBuild(work, options)
  const assignments = datasetManifestSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === job.split)
  const configurations = [...new Map(job.configs.map(config => [config.resolvedHash, config])).values()]
  const outputs: z.infer<typeof waveformEvaluationSchema>['outputs'] = []
  let count = 0
  for (const cohort of assignments) {
    const input = dataset.snapshot.waveformInputs.find(row => row.cohortId === cohort.cohortId)?.input
    if (!input) throw new Error('Missing retained waveform cohort')
    for (const config of configurations) {
      if (options.signal.aborted) throw new Error('Waveform job cancelled')
      const configs = dataset.snapshot.side === 'left'
        ? { left: config.resolved, right: job.waveform.otherSide.resolved }
        : { left: job.waveform.otherSide.resolved, right: config.resolved }
      const output = await runWaveformChild(location, { version: 'retained-waveform-work-v1', input, configs }, {
        signal: options.signal, timeoutMs: options.replayBudget?.waveformWallMs ?? options.timeoutMs,
        cpuSeconds: options.replayBudget?.waveformCpuSeconds, expectedBuildHash: job.waveform.pythonBuildHash,
      })
      count += output.readings.length
      if (count > 20000) throw new Error('Waveform job derived reading budget exceeded')
      outputs.push({ cohortId: cohort.cohortId, configHash: config.resolvedHash, ...output })
    }
  }
  await verifyWaveformJobBuild(work, options)
  return waveformEvaluationSchema.parse({ hash: dataHash(outputs), outputs })
}
