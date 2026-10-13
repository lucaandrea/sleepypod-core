import { TRPCClientError } from '@trpc/client'
import { z } from 'zod'
import { defaultConfig, resolveOverrides } from '@/src/biometrics/algorithms/registry-core'
import { canonicalJson } from '@/src/biometrics/algorithms/canonical-json'
import { prepareShadowRequestSchema } from '@/src/biometrics/shadow/preparation-contracts'
import { submitShadowSchema } from '@/src/biometrics/shadow/submission-contracts'
import { summarizeShadowSnapshot, type ShadowReportSnapshot } from '@/src/biometrics/shadow/report-core'
import { referenceImportSchema } from '@/src/biometrics/references/contracts'
import { biometricTuning } from './biometricTuning'
import { previewDemoReference } from './biometric-references'
import { hash, dataHash, uuid } from './biometric-utils'
import type { DemoHandlers, RouterInputs, RouterOutputs } from '../types'

type Plan = RouterInputs['biometricShadow']['create']['plan']
type Descriptor = RouterOutputs['biometricShadow']['get']
interface Record { plan: Plan, descriptor: Descriptor, attemptId: string, frozenAt?: number }
const TEMPLATE = 'simulated-heart-rate-v1'
const INTERVAL = 5000
const MAXIMUM_WINDOW = 600000
const prepared = new Map<string, Plan>()
const runs = new Map<string, Record>()
const requests = new Map<string, { fingerprint: string, id: string }>()
let queue: Promise<unknown> = Promise.resolve()
function rejectedPlan(message: string) {
  return TRPCClientError.from({ error: { message, code: -32600, data: { code: 'BAD_REQUEST', httpStatus: 400 } } })
}
function serialize<T>(action: () => Promise<T>) {
  const result = queue.then(action)
  queue = result.catch(() => {})
  return result
}
async function bindings() {
  const overview = biometricTuning.getProfileOverview
  if (!overview) throw new Error('Demo profile overview unavailable')
  const [left, right] = await Promise.all(['left', 'right'].map(side => overview({ side: side as 'left' | 'right' })))
  // Demo generations are explicitly synthetic; no runtime acknowledgement exists.
  return { left: { generation: left.desired.binding.generation + 1, resolvedHash: left.desired.hash },
    right: { generation: right.desired.binding.generation + 1, resolvedHash: right.desired.hash } }
}
function get(id: string) {
  z.string().uuid().parse(id)
  const record = runs.get(id)
  if (!record) throw new Error('NOT_FOUND: simulated observation')
  return record
}
function samples(record: Record, at: number): ShadowReportSnapshot['samples'] {
  const { plan } = record
  const count = Math.max(0, Math.min(Math.ceil((plan.endMs - plan.startMs) / INTERVAL), Math.floor((at - plan.startMs) / INTERVAL) + 1))
  return Array.from({ length: count }, (_, index) => ({ sequence: index, attemptId: record.attemptId, side: plan.side,
    timestampMs: plan.startMs + index * INTERVAL, inputHash: null,
    candidateConfigHash: plan.candidateConfigHash, activeConfigHash: plan.activeConfigHash,
    readings: [{ metric: 'heart_rate', active: { value: 60 + index % 3, quality: 1 },
      candidate: { value: index % 4 === 3 ? null : 59 + index % 3, quality: 1 } }] }))
}
function snapshot(record: Record) {
  const now = Date.now(), at = record.frozenAt ?? Math.min(now, record.plan.endMs)
  const rows = samples(record, at)
  const d = record.descriptor
  if (d.state !== 'stopped') {
    d.state = now < d.startMs ? 'pending' : now < d.endMs ? 'running' : 'completed'
    d.endedAtMs = d.state === 'completed' ? d.endMs : null
  }
  d.pointCount = rows.length
  d.byteCount = new TextEncoder().encode(canonicalJson(rows)).byteLength
  d.heartbeatAtMs = rows.length ? at : null
  return { descriptor: structuredClone(d), rows, at }
}
async function prepare(raw: RouterInputs['biometricShadow']['prepare']) {
  const input = prepareShadowRequestSchema.parse(raw)
  if (input.templateId !== TEMPLATE || input.startMs <= Date.now() || input.endMs <= input.startMs || input.endMs - input.startMs > MAXIMUM_WINDOW) throw new Error('BAD_REQUEST: choose a future demo window of at most ten minutes')
  const expectedBindings = await bindings()
  const readRevision = biometricTuning.getProfileRevision
  if (!readRevision) throw new Error('Demo profile revision unavailable')
  const revision = input.candidateRevisionId === null ? null : await readRevision({ id: input.candidateRevisionId })
  if (revision && revision.side !== input.side) throw new Error('BAD_REQUEST: candidate belongs to the other side')
  const candidateConfigHash = await hash(revision ? resolveOverrides(revision.overrides).resolved : defaultConfig)
  const activeConfigHash = expectedBindings[input.side].resolvedHash
  const identity = await hash({ simulated: true, template: TEMPLATE })
  const plan = submitShadowSchema.shape.plan.parse({ schema: 'biometric-shadow-plan-v1', side: input.side, subjectId: input.subjectId,
    startMs: input.startMs, endMs: input.endMs, candidateRevisionId: input.candidateRevisionId, candidateConfigHash, activeConfigHash,
    expectedBindings, engineBuildHash: identity, qualificationHash: identity, maximumPoints: 120, maximumBytes: 1000000, metrics: ['heart_rate'],
    monitoring: { expectedIntervalMs: INTERVAL, maximumGapMs: INTERVAL * 2, heartbeatStaleMs: 10000, minimumCandidateCoverage: 0.8,
      maximumCoverageLoss: 0.1, minimumQuality: 0.5, alignment: { version: 'reference-alignment-v1', pointToleranceMs: 1000, clockOffsetMs: 0, offsetSource: 'fixed' } },
    joining: { maximumPendingPoints: 120, maximumLatenessMs: 1000, drainGraceMs: 2000 },
    execution: { version: 'shadow-execution-policy-v1', configHashes: { left: expectedBindings.left.resolvedHash, right: expectedBindings.right.resolvedHash, [input.side]: candidateConfigHash },
      maximumRecords: 120, maximumOutputs: 120, maximumCpuMs: 1000, maximumInputBytes: 1000000, maximumOutputBytes: 1000000,
      budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: MAXIMUM_WINDOW + 2000,
        acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
      leaseMs: 3000, heartbeatMs: 500, sources: { pollMs: 100, maximumActiveRows: 100, databaseBusyTimeoutMs: 50,
        frames: { maximumFrames: 120, maximumBytes: 1000000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
        context: { presenceStaleMs: 1000, pumpStaleMs: 1000, maximumPresenceBytes: 4096 } } } })
  const planHash = await hash(plan)
  const oldest = prepared.keys().next().value
  if (prepared.size >= 100 && oldest) prepared.delete(oldest)
  prepared.set(planHash, structuredClone(plan))
  return { status: 'prepared_not_admitted' as const, plan, planHash }
}
async function create(raw: RouterInputs['biometricShadow']['create']) {
  const input = submitShadowSchema.parse(raw), fingerprint = await hash(input.plan)
  const previous = requests.get(input.idempotencyKey)
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('CONFLICT: scheduling key reused with another plan')
    return snapshot(get(previous.id)).descriptor
  }
  if (!prepared.has(fingerprint) || input.plan.startMs <= Date.now()) throw rejectedPlan('BAD_REQUEST: prepare a future demo plan again')
  if (canonicalJson(input.plan.expectedBindings) !== canonicalJson(await bindings())) throw rejectedPlan('BAD_REQUEST: demo profiles changed; prepare again')
  if (runs.size >= 20) throw new Error('PAYLOAD_TOO_LARGE: demo run limit reached')
  const id = uuid(), descriptor: Descriptor = { id, side: input.plan.side, subjectId: input.plan.subjectId, state: 'pending',
    planHash: fingerprint, candidateConfigHash: input.plan.candidateConfigHash, activeConfigHash: input.plan.activeConfigHash,
    candidateRevisionId: input.plan.candidateRevisionId, candidateIdentitySaved: true, startMs: input.plan.startMs, endMs: input.plan.endMs,
    createdAtMs: Date.now(), endedAtMs: null, heartbeatAtMs: null, reason: 'simulated_demo_no_hardware', pointCount: 0, byteCount: 0, workerReceiptAvailable: false }
  runs.set(id, { plan: structuredClone(input.plan), descriptor, attemptId: uuid() })
  requests.set(input.idempotencyKey, { fingerprint, id })
  return structuredClone(descriptor)
}
async function report(input: RouterInputs['biometricShadow']['report'], rawReference?: RouterInputs['biometricShadow']['compare']['reference']) {
  const record = get(input.id), referenceInput = rawReference === undefined ? null : referenceImportSchema.parse(rawReference)
  if (referenceInput && (referenceInput.side !== record.plan.side || referenceInput.subjectId !== record.plan.subjectId)) throw new Error('Reference subject or side mismatch')
  if (new TextEncoder().encode(JSON.stringify({ type: 'readShadowReport', input: { ...input, reference: rawReference } })).byteLength > 65536) throw new Error('Reference comparison is limited to a 64 KiB request')
  const reference = referenceInput ? await previewDemoReference(referenceInput) : null
  const { descriptor: d, rows, at } = snapshot(record)
  const snapshotHash = await dataHash({ simulated: true, descriptor: d, rows, at })
  const result = summarizeShadowSnapshot({ samples: rows, capturedAtMs: at, snapshotHash, run: {
    id: d.id, plan: record.plan, plan_hash: d.planHash, state: d.state, reason: d.reason, heartbeat_at_ms: d.heartbeatAtMs,
    lease_until_ms: d.state === 'running' ? at + 3000 : null, workerReceipt: null,
  } }, reference, await hash(record.plan.execution))
  result.health = 'issues_detected'
  result.issues.unshift('simulated_demo')
  result.limitations.push('SIMULATED DEMO: generated readings, no hardware execution or resource qualification. Not activation evidence.')
  return { ...result, reportHash: await dataHash(result) }
}
export const biometricShadow = {
  templates: () => ({ items: [{ id: TEMPLATE, label: 'SIMULATED DEMO — heart rate with missing candidate readings', maximumWindowMs: MAXIMUM_WINDOW }] }),
  prepare, create: input => serialize(() => create(input)),
  list: ({ side, maximumRuns = 20, afterId }) => {
    z.number().int().min(1).max(50).parse(maximumRuns)
    const rows = [...runs.values()].filter(row => row.plan.side === side && (!afterId || row.descriptor.id > afterId))
      .sort((a, b) => a.descriptor.id < b.descriptor.id ? -1 : 1)
    const items = rows.slice(0, maximumRuns).map(row => snapshot(row).descriptor)
    return { items, nextCursor: rows.length > maximumRuns ? items.at(-1)?.id ?? null : null }
  },
  get: ({ id }) => snapshot(get(id)).descriptor,
  report, compare: input => report({ id: input.id }, input.reference),
  stop: ({ id }) => {
    const record = get(id), { descriptor, at } = snapshot(record)
    if (descriptor.state === 'pending' || descriptor.state === 'running') {
      record.frozenAt = at
      record.descriptor.state = 'stopped'
      record.descriptor.endedAtMs = Date.now()
    }
    return { run: snapshot(record).descriptor, localAttemptSettled: false }
  },
} satisfies DemoHandlers<'biometricShadow'>
