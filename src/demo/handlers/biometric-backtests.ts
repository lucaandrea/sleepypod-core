import { pageReferenceTraces, referenceTraceIdentity } from '@/src/biometrics/backtest/reference-trace-page'
import { pageNumericTraces } from '@/src/biometrics/backtest/numeric-trace-page'
import type { DemoHandlers, RouterOutputs, RouterInputs } from '../types'
import { experimentProtocolSchema } from '@/src/biometrics/backtest/contracts'
import { summarizeBacktestResult } from '@/src/biometrics/backtest/report-summary'
import { pageStageTraces } from '@/src/biometrics/backtest/trace-page'
import { runDemoEvaluation } from '../biometrics/run'
import workerBuild from '../biometrics/worker-build.json'
import { demoDatasetSnapshot, demoDatasetBusy } from './biometric-datasets'
import { dataHash, hash, uuid } from './biometric-utils'

type API = RouterOutputs['biometricTuning']
type Work = Parameters<typeof runDemoEvaluation>[0]
type Profiles = (side: 'left' | 'right', revisionId: string, generation: number) => Promise<Work['job']['configs']>
interface Record { side: 'left' | 'right', job: API['getBacktest'], work: Work | null, result: API['getBacktestResult'], controller: AbortController }
const experiments: Array<{ descriptor: API['getExperiment'], key: string, fingerprint: string }> = []
const jobs: Record[] = []
const requests = new Map<string, { fingerprint: string, record: Record }>()
const exposures: Array<{ jobId: string, side: 'left' | 'right', windows: Array<{ startMs: number, endMs: number }> }> = []
let queue: Promise<unknown> = Promise.resolve(), working = false
const serialized = <T>(fn: () => Promise<T>) => {
  const work = queue.then(fn)
  queue = work.catch(() => {})
  return work
}
function experiment(id: string) {
  const row = experiments.find(row => row.descriptor.id === id)
  if (!row) throw new Error('NOT_FOUND: demo experiment')
  return row.descriptor
}
function job(id: string) {
  const row = jobs.find(row => row.job.id === id)
  if (!row) throw new Error('NOT_FOUND: demo job')
  return row
}
function holdoutCount(datasetId: string) {
  // Descriptor remains available after input release, as do exposure windows.
  const selection = datasetWindows.get(datasetId)
  if (!selection) return 0
  return exposures.filter(row => row.side === selection.side && row.windows.some(a => selection.windows.some(b => a.startMs < b.endMs && a.endMs > b.startMs))).length
}
const datasetWindows = new Map<string, { side: 'left' | 'right', windows: Array<{ startMs: number, endMs: number }> }>()
function result(row: Record) {
  return row.result ? structuredClone({ ...row.result, currentHoldoutUseCount: holdoutCount(row.job.datasetId) }) : null
}
function page<T extends { id: string, createdAtMs: number }>(rows: T[], input: { beforeId?: string, beforeCreatedAtMs?: number }) {
  const filtered = rows.filter(row => input.beforeCreatedAtMs === undefined || row.createdAtMs < input.beforeCreatedAtMs || (row.createdAtMs === input.beforeCreatedAtMs && row.id < (input.beforeId ?? ''))).sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
  const items = filtered.slice(0, 50), last = items[items.length - 1]
  return { items: structuredClone(items), nextCursor: filtered.length > 50 && last ? { id: last.id, createdAtMs: last.createdAtMs } : null }
}
async function pump() {
  if (working) return
  const row = jobs.find(row => row.job.state === 'queued')
  if (!row?.work) return
  working = true
  row.job.state = 'running'
  row.job.attempt = 1
  row.job.updatedAtMs = Date.now()
  try {
    const report = await runDemoEvaluation(row.work, (completedNights, totalNights) => {
      row.job.progress = { phase: 'demo_evaluating', completedNights, totalNights }
    }, row.controller.signal)
    report.limitations.unshift('Synthetic demo evaluation in this browser; no pod processing or validated improvement.')
    const bytes = new TextEncoder().encode(JSON.stringify(report)).byteLength
    if (bytes > 16 * 1024 * 1024 || jobs.reduce((sum, item) => sum + (item.result?.available ? new TextEncoder().encode(JSON.stringify(item.result.report)).byteLength : 0), 0) + bytes > 64 * 1024 * 1024) throw new Error('RESOURCE_LIMIT: demo report retention budget reached')
    const contentHash = await dataHash(report)
    if (row.controller.signal.aborted) throw new Error('Demo evaluation cancelled')
    row.result = { jobId: row.job.id, fencingToken: 1, report, contentHash, completedAtMs: Date.now(), releasedAtMs: null, available: true, currentHoldoutUseCount: holdoutCount(row.job.datasetId) }
    row.job.state = 'succeeded'
    row.job.progress.phase = 'complete'
  }
  catch (error) {
    row.job.state = row.controller.signal.aborted ? 'cancelled' : 'failed'
    row.job.error = row.controller.signal.aborted ? null : error instanceof Error ? error.message : 'Demo evaluation failed'
  }
  finally {
    row.work = null
    row.job.updatedAtMs = Date.now()
    demoDatasetBusy(row.job.datasetId, row.job.id, false)
    working = false
    setTimeout(() => void pump(), 0)
  }
}
export function createDemoBacktestHandlers(loadProfiles: Profiles): DemoHandlers<'biometricTuning'> {
  return {
    createExperiment: input => serialized(async () => {
      const protocol = experimentProtocolSchema.parse(input.protocol), fingerprint = await hash({ datasetId: input.datasetId, protocol })
      const prior = experiments.find(row => row.key === input.idempotencyKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('REVISION_CONFLICT: experiment request changed')
        return structuredClone(prior.descriptor)
      }
      if (experiments.length >= 200) throw new Error('RESOURCE_LIMIT: demo experiment limit')
      const { descriptor: dataset } = demoDatasetSnapshot(input.datasetId)
      const descriptor: API['getExperiment'] = { id: uuid(), datasetId: dataset.id, side: dataset.side, protocol, protocolHash: await hash(protocol), holdoutAccesses: 0, createdAtMs: Date.now() }
      experiments.push({ descriptor, key: input.idempotencyKey, fingerprint })
      return structuredClone(descriptor)
    }),
    getExperiment: ({ id }) => structuredClone(experiment(id)),
    listExperiments: input => page(experiments.map(row => row.descriptor).filter(row => row.side === input.side), input),
    enqueueBacktest: (input: RouterInputs['biometricTuning']['enqueueBacktest']) => serialized(async () => {
      const fingerprint = await hash(input), prior = requests.get(input.idempotencyKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('REVISION_CONFLICT: job request changed')
        return structuredClone(prior.record.job)
      }
      if (jobs.length >= 200 || jobs.filter(row => row.work !== null).length >= 8) throw new Error('RESOURCE_LIMIT: demo job limit')
      const selected = experiment(input.experimentId), retained = demoDatasetSnapshot(selected.datasetId)
      const assignments = retained.descriptor.manifest.splitProtocol.assignments.filter(row => row.split === input.split)
      if (!assignments.length) throw new Error('INVALID_SELECTION: no nights in selected split')
      const configs = await loadProfiles(selected.side, input.candidateRevisionId, input.expectedBindingGeneration)
      // Recheck release after awaited profile hashing before publishing the job.
      demoDatasetSnapshot(selected.datasetId)
      const id = uuid(), now = Date.now()
      datasetWindows.set(selected.datasetId, { side: selected.side, windows: retained.descriptor.manifest.splitProtocol.assignments })
      if (input.split === 'holdout') {
        exposures.push({ jobId: id, side: selected.side, windows: assignments })
        selected.holdoutAccesses++
      }
      const holdoutUse = holdoutCount(selected.datasetId)
      const work: Work = { dataset: { manifest: retained.descriptor.manifest, snapshot: retained.snapshot }, job: { version: 'backtest-job-v1', experimentId: selected.id, datasetId: selected.datasetId, datasetHash: retained.descriptor.contentHash,
        evaluatorBuildHash: workerBuild.buildHash, protocol: selected.protocol, protocolHash: selected.protocolHash, holdoutUse, evidence: input.split === 'holdout' && holdoutUse > 1 ? 'reused_holdout_is_validation' : 'descriptive_only', configs, split: input.split, idempotencyKey: input.idempotencyKey } }
      const descriptor: API['getBacktest'] = { id, experimentId: selected.id, datasetId: selected.datasetId, datasetHash: retained.descriptor.contentHash, evaluatorBuildHash: workerBuild.buildHash, split: input.split,
        state: 'queued', attempt: 0, progress: { phase: 'demo_queued', completedNights: 0, totalNights: assignments.length }, cancellationRequestedAtMs: null, error: null, createdAtMs: now, updatedAtMs: now,
        configurations: configs.map(config => ({ label: config.label, revisionId: config.revisionId, hash: config.resolvedHash })), evaluationScope: selected.protocol.mode === 'stage_replay' ? 'stage_rules_on_original_readings' : 'original_readings_comparison' }
      const record: Record = { side: selected.side, job: descriptor, work, result: null, controller: new AbortController() }
      jobs.push(record)
      requests.set(input.idempotencyKey, { fingerprint, record })
      demoDatasetBusy(selected.datasetId, id, true)
      setTimeout(() => void pump(), 0)
      return structuredClone(descriptor)
    }),
    listBacktests: input => page(jobs.filter(row => row.side === input.side).map(row => row.job), input),
    getBacktest: ({ id }) => structuredClone(job(id).job),
    cancelBacktest: ({ id }) => {
      const row = job(id)
      if (row.job.state === 'queued' || row.job.state === 'running' || row.job.state === 'cancel_requested') {
        row.job.cancellationRequestedAtMs ??= Date.now()
        row.controller.abort()
        if (row.job.state === 'queued') {
          row.job.state = 'cancelled'
          row.work = null
          demoDatasetBusy(row.job.datasetId, id, false)
        }
        else row.job.state = 'cancel_requested'
      }
      return structuredClone(row.job)
    },
    getBacktestResult: ({ id }) => result(job(id)),
    getBacktestSummary: ({ id }) => summarizeBacktestResult(result(job(id))),
    getBacktestTrace: (input) => {
      const report = result(job(input.id))
      if (!report?.available) throw new Error('RESULT_RELEASED: report unavailable')
      if (report.contentHash !== input.expectedContentHash) throw new Error('REVISION_CONFLICT: report hash changed')
      return pageStageTraces(report.report, input)
    },
    getBacktestNumericTrace: (input) => {
      const report = result(job(input.id))
      if (!report?.available) throw new Error('RESULT_RELEASED: report unavailable')
      if (report.contentHash !== input.expectedContentHash) throw new Error('REVISION_CONFLICT: report hash changed')
      return pageNumericTraces(report.report, input)
    },
    getBacktestReferenceTrace: (input) => {
      const report = result(job(input.id))
      if (!report?.available) throw new Error('RESULT_RELEASED: report unavailable')
      if (report.contentHash !== input.expectedContentHash) throw new Error('REVISION_CONFLICT: report hash changed')
      const identity = referenceTraceIdentity(report.report)
      const retained = demoDatasetSnapshot(identity.datasetId)
      return pageReferenceTraces(report.report, { contentHash: retained.descriptor.contentHash, snapshot: retained.snapshot }, input)
    },
    releaseBacktestResult: ({ id, expectedContentHash }) => {
      const row = job(id)
      if (!row.result) throw new Error('INVALID_STATE: no completed report')
      if (row.result.contentHash !== expectedContentHash) throw new Error('REVISION_CONFLICT: report hash changed')
      row.result.report = {}
      row.result.available = false
      row.result.releasedAtMs ??= Date.now()
      return result(row)
    },
  }
}
