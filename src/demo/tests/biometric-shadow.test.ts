// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { shadowReportSchema } from '@/src/biometrics/shadow/report-contracts'
import { shadowRunDescriptorSchema } from '@/src/biometrics/shadow/descriptors'
import { preparedShadowPlanSchema } from '@/src/biometrics/shadow/preparation-contracts'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
const now = 1700000000000
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())
async function setup() {
  const { biometricShadow: demo } = await import('../handlers/biometricShadow')
  const templates = await demo.templates()
  const input = { templateId: templates.items[0].id, side: 'left' as const, subjectId: 'demo-sleeper', candidateRevisionId: null, startMs: now + 1000, endMs: now + 21000 }
  const prepared = await demo.prepare(input)
  expect(preparedShadowPlanSchema.parse(prepared)).toEqual(prepared)
  return { demo, input, prepared }
}
it('supports prepare, exact scheduling retry, bounded listing, progression and real reference calculations', async () => {
  const { demo, prepared } = await setup()
  const request = { plan: prepared.plan, idempotencyKey: 'same' }
  const [first, retry] = await Promise.all([demo.create(request), demo.create(request)])
  expect(retry.id).toBe(first.id)
  expect(shadowRunDescriptorSchema.parse(first).state).toBe('pending')
  expect((await demo.list({ side: 'right' })).items).toEqual([])
  expect((await demo.list({ side: 'left', maximumRuns: 1 })).items).toHaveLength(1)
  vi.setSystemTime(now + 21000)
  const run = await demo.get({ id: first.id })
  expect(run).toMatchObject({ state: 'completed', pointCount: 4, workerReceiptAvailable: false })
  const report = await demo.compare({ id: first.id, reference: { side: 'left', subjectId: 'demo-sleeper', source: 'synthetic reference',
    rows: [0, 1, 2, 3].map(index => ({ recordKey: String(index), metric: 'heart_rate', unit: 'bpm', value: 60 + index % 3, timestampMs: now + 1000 + index * 5000 })) } })
  expect(shadowReportSchema.parse(report)).toEqual(report)
  expect(report.workerReceipt).toBeNull()
  expect(report.issues).toContain('simulated_demo')
  expect(report.metrics[0].comparison).toMatchObject({ coverageReduced: true, lostObservationTimestamps: 1,
    commonSupport: { baseline: { pairedCount: 3, metrics: { mae: 0 } }, candidate: { pairedCount: 3, metrics: { mae: 1 } } } })
  const { reportHash, ...body } = report
  expect(reportHash).toBe(dataHash(body))
  await expect(demo.create({ ...request, plan: { ...request.plan, subjectId: 'changed' } })).rejects.toThrow('CONFLICT')
  expect((await demo.create(request)).id).toBe(first.id) // Retry after window ends.
  expect((await demo.stop({ id: first.id })).run.state).toBe('completed')
})
it('stops without adding future observations and refuses reference sleeper substitution', async () => {
  const { demo, prepared } = await setup()
  const run = await demo.create({ plan: prepared.plan, idempotencyKey: 'stop' })
  vi.setSystemTime(now + 7000)
  const stopped = await demo.stop({ id: run.id })
  expect(stopped).toMatchObject({ localAttemptSettled: false, run: { state: 'stopped', pointCount: 2 } })
  vi.setSystemTime(now + 60000)
  expect(await demo.stop({ id: run.id })).toEqual(stopped)
  expect((await demo.report({ id: run.id })).observedSamples).toBe(2)
  await expect(demo.compare({ id: run.id, reference: { side: 'right', subjectId: 'demo-sleeper', source: 'reference', rows: [{ recordKey: 'x', metric: 'heart_rate', unit: 'bpm', value: 60, timestampMs: now + 1000 }] } })).rejects.toThrow('subject or side')
})
it('rejects forged, past and stale plans rather than accepting arbitrary browser metadata', async () => {
  const { demo, input, prepared } = await setup()
  await expect(demo.prepare({ ...input, startMs: now - 1 })).rejects.toThrow('future')
  await expect(demo.create({ plan: { ...prepared.plan, candidateConfigHash: 'a'.repeat(64), execution: { ...prepared.plan.execution,
    configHashes: { ...prepared.plan.execution.configHashes, left: 'a'.repeat(64) } } }, idempotencyKey: 'forged' })).rejects.toThrow('prepare')
  const { biometricTuning } = await import('../handlers/biometricTuning')
  const reset = biometricTuning.resetProfile
  if (!reset) throw new Error('Missing demo reset')
  await reset({ side: 'right', expectedGeneration: 0, expectedResolvedHash: prepared.plan.expectedBindings.right.resolvedHash,
    boundary: 'immediate', requester: 'demo-test', idempotencyKey: 'change-other-side', allowUnvalidated: true })
  await expect(demo.create({ plan: prepared.plan, idempotencyKey: 'stale' })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  vi.setSystemTime(now + 1001)
  await expect(demo.create({ plan: prepared.plan, idempotencyKey: 'past' })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
})
it('bundles the complete demo handler for browsers without Node or hardware imports', async () => {
  vi.useRealTimers()
  const result = await build({ entryPoints: ['src/demo/handlers/biometricShadow.ts'], bundle: true, platform: 'browser', write: false, metafile: true })
  expect(Object.keys(result.metafile.inputs).filter(path => /src\/(hardware|streaming|db)\//.test(path))).toEqual([])
  expect(result.outputFiles[0].text).toContain('simulated_demo')
})
