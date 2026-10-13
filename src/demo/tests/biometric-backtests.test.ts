// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { biometricTuning as handlers } from '../handlers/biometricTuning'
import { evaluateDemoBacktest } from '../biometrics/evaluator'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
const mock = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../biometrics/run', () => ({ runDemoEvaluation: mock.run }))
function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}
const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'stage_replay' as const, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
beforeEach(() => {
  mock.run.mockImplementation(async (input, progress) => evaluateDemoBacktest(input, progress))
})
async function prepare(key: string) {
  const sessions = await required(handlers.listSessions)({ side: 'left' })
  const selection = { side: 'left' as const, subjectId: 'demo', sessionIds: sessions.items.slice(0, 3).map(row => row.id), referenceImportIds: [], idempotencyKey: `${key}-dataset` }
  const dataset = await required(handlers.createDataset)(selection)
  const experiment = await required(handlers.createExperiment)({ datasetId: dataset.id, protocol, idempotencyKey: `${key}-experiment` })
  const candidate = await required(handlers.createProfileRevision)({ side: 'left', overrides: [], origin: 'manual', requester: 'demo-test', idempotencyKey: `${key}-candidate` })
  return { dataset, experiment, candidate, selection }
}
async function completed(id: string) {
  await vi.waitFor(async () => expect((await required(handlers.getBacktest)({ id })).state).toBe('succeeded'))
  const report = await required(handlers.getBacktestResult)({ id })
  const summary = await required(handlers.getBacktestSummary)({ id })
  expect(summary).toMatchObject({ contentHash: report?.contentHash, contentHashScope: 'complete_retained_report' })
  expect(JSON.stringify(summary?.report)).not.toContain('"blocks"')
  if (!report) throw new Error('Missing report')
  return report
}
it('pins three configurations and produces real paged reports without activating the candidate', async () => {
  const prepared = await prepare('complete')
  const request = { experimentId: prepared.experiment.id, candidateRevisionId: prepared.candidate.id, expectedBindingGeneration: 0, split: 'tuning' as const, idempotencyKey: 'complete-job' }
  const queued = await required(handlers.enqueueBacktest)(request)
  expect(queued.state).toBe('queued')
  expect(queued.configurations.map(row => row.label)).toEqual(['default', 'current', 'candidate'])
  expect((await required(handlers.enqueueBacktest)(request)).id).toBe(queued.id)
  await expect(required(handlers.enqueueBacktest)({ ...request, split: 'validation' })).rejects.toThrow('REVISION_CONFLICT')
  const result = await completed(queued.id)
  expect(result.contentHash).toBe(dataHash(result.report))
  expect(result.report).toMatchObject({ status: 'insufficient_evidence', datasetHash: prepared.dataset.contentHash })
  const trace = await required(handlers.getBacktestTrace)({ id: queued.id, expectedContentHash: result.contentHash, configuration: 'candidate', limit: 1 })
  expect(() => required(handlers.getBacktestNumericTrace)({ id: queued.id, expectedContentHash: result.contentHash, configuration: 'candidate' })).toThrow('Numeric trace format or side provenance is unavailable')
  const tuning = prepared.dataset.manifest.splitProtocol.assignments.find(row => row.split === 'tuning')
  if (!tuning) throw new Error('Missing tuning cohort')
  const referenceRequest = { id: queued.id, expectedContentHash: result.contentHash, cohortId: tuning.cohortId, metric: 'heart_rate' as const }
  expect(await required(handlers.getBacktestReferenceTrace)(referenceRequest)).toMatchObject({ datasetHash: prepared.dataset.contentHash, items: [], totalItems: 0 })
  expect(() => required(handlers.getBacktestReferenceTrace)({ ...referenceRequest, expectedContentHash: '0'.repeat(64) })).toThrow('REVISION_CONFLICT')
  await required(handlers.releaseDataset)({ id: prepared.dataset.id })
  expect(() => required(handlers.getBacktestReferenceTrace)(referenceRequest)).toThrow('DATASET_RELEASED')
  expect(trace.items).toHaveLength(1)
  expect(trace.nextCursor?.offset).toBe(1)
  expect((await required(handlers.getProfileOverview)({ side: 'left' })).desired.binding.generation).toBe(0)
  expect(() => required(handlers.releaseBacktestResult)({ id: queued.id, expectedContentHash: '0'.repeat(64) })).toThrow('REVISION_CONFLICT')
  const released = await required(handlers.releaseBacktestResult)({ id: queued.id, expectedContentHash: result.contentHash })
  expect(released).toMatchObject({ available: false, report: {}, contentHash: result.contentHash })
  expect(() => required(handlers.getBacktestTrace)({ id: queued.id, expectedContentHash: result.contentHash, configuration: 'candidate' })).toThrow('RESULT_RELEASED')
})
it('tracks holdout exposure across cloned datasets and preserves the audit after report release', async () => {
  const prepared = await prepare('holdout')
  const first = await required(handlers.enqueueBacktest)({ experimentId: prepared.experiment.id, candidateRevisionId: prepared.candidate.id, expectedBindingGeneration: 0, split: 'holdout', idempotencyKey: 'holdout-one' })
  const report = await completed(first.id)
  const clone = await required(handlers.createDataset)({ ...prepared.selection, idempotencyKey: 'clone-dataset' })
  const experiment = await required(handlers.createExperiment)({ datasetId: clone.id, protocol, idempotencyKey: 'clone-experiment' })
  const second = await required(handlers.enqueueBacktest)({ experimentId: experiment.id, candidateRevisionId: prepared.candidate.id, expectedBindingGeneration: 0, split: 'holdout', idempotencyKey: 'holdout-two' })
  const secondReport = await completed(second.id)
  expect(secondReport.currentHoldoutUseCount).toBe(2)
  expect(secondReport.report).toMatchObject({ evidence: 'reused_holdout_is_validation' })
  expect((await required(handlers.getBacktestResult)({ id: first.id }))?.currentHoldoutUseCount).toBe(2)
  await required(handlers.releaseBacktestResult)({ id: first.id, expectedContentHash: report.contentHash })
  expect((await required(handlers.getBacktestResult)({ id: first.id }))?.currentHoldoutUseCount).toBe(2)
})
it('cancels running work without publishing a report and then releases its retained inputs', async () => {
  mock.run.mockImplementation((_input, _progress, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
  const prepared = await prepare('cancel')
  const queued = await required(handlers.enqueueBacktest)({ experimentId: prepared.experiment.id, candidateRevisionId: prepared.candidate.id, expectedBindingGeneration: 0, split: 'tuning', idempotencyKey: 'cancel-job' })
  await vi.waitFor(async () => expect((await required(handlers.getBacktest)({ id: queued.id })).state).toBe('running'))
  expect(() => required(handlers.releaseDataset)({ id: prepared.dataset.id })).toThrow('active demo job')
  expect((await required(handlers.cancelBacktest)({ id: queued.id })).state).toBe('cancel_requested')
  await vi.waitFor(async () => expect((await required(handlers.getBacktest)({ id: queued.id })).state).toBe('cancelled'))
  expect(await required(handlers.getBacktestResult)({ id: queued.id })).toBeNull()
  expect((await required(handlers.releaseDataset)({ id: prepared.dataset.id })).available).toBe(false)
})
