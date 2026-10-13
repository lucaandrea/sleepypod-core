// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShadowStore } from '../store'
import { reportShadowRun } from '../report'
import { ShadowWorkerSink } from '../worker-sink'
import { ShadowStreamJoin } from '../stream-join'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const hash = 'a'.repeat(64), start = 1700000000000
const plan = { subjectId: 'fixture', monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 2000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
  alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } }, schema: 'biometric-shadow-plan-v1', side: 'left', candidateConfigHash: hash, activeConfigHash: 'b'.repeat(64),
qualificationHash: 'c'.repeat(64), engineBuildHash: 'd'.repeat(64), startMs: start, endMs: start + 60000,
maximumPoints: 3, maximumBytes: 10000, metrics: ['heart_rate'] }
function setup(policy = { maximumRuns: 10, maximumPoints: 10, maximumBytes: 100000 }) {
  const db = new Database(':memory:')
  databases.push(db)
  migrate(drizzle(db), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
  let now = start
  return { db, store: new ShadowStore(db, policy, () => now), advance: (ms: number) => {
    now += ms
  } }
}
function sample(sequence = 0) {
  return { sequence, side: 'left', timestampMs: start + sequence, inputHash: hash, candidateConfigHash: hash, activeConfigHash: plan.activeConfigHash,
    readings: [{ metric: 'heart_rate', candidate: { value: null as number | null, quality: 0 }, active: { value: 60, quality: 1 } }] }
}
const joining = { maximumPendingPoints: 10, maximumLatenessMs: 1000, drainGraceMs: 2000 }
function workerOutput(timestampMs: number, sequence = 0) {
  return { sequence, inputHash: hash, side: 'left', sourceSide: 'left', timestampMs, configHash: hash,
    readings: [{ metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 60, quality: 1 },
      { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: 15, quality: 1 },
      { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 }], flags: null, limitations: [] }
}
function activeOutput(timestampMs: number) {
  return { side: 'left', timestampMs, configHash: plan.activeConfigHash, readings: workerOutput(timestampMs).readings }
}
describe('separate prospective shadow storage', () => {
  it('uses the generated additive migration and never writes canonical observations', () => {
    const { db, store } = setup()
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER deny_vitals_${operation} BEFORE ${operation} ON vitals BEGIN SELECT RAISE(ABORT, 'canonical write forbidden'); END`)
    const before = db.prepare('SELECT * FROM vitals').all()
    const run = store.create(plan, 'create')
    const lease = store.claim(run.id, 10000, (admitted) => {
      expect(admitted.qualificationHash).toBe(plan.qualificationHash)
    })
    expect(store.append(lease, sample())).toEqual({ state: 'recorded' })
    expect(store.append(lease, sample())).toEqual({ state: 'already_recorded' })
    expect(store.get(run.id)).toMatchObject({ point_count: 1, state: 'running' })
    expect(db.prepare('SELECT * FROM vitals').all()).toEqual(before)
    const payload = JSON.parse((db.prepare('SELECT payload FROM biometric_shadow_samples').get() as { payload: string }).payload)
    expect(payload).toMatchObject({ attemptId: lease.attemptId, readings: [{ candidate: { value: null }, active: { value: 60 } }] })
  })
  it('rejects retroactive windows and changed idempotency requests, while exact retries survive time passing', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    advance(100)
    expect(store.create(plan, 'first').id).toBe(run.id)
    expect(() => store.create(plan, 'second')).toThrow('prospective')
    expect(() => store.create({ ...plan, side: 'right' }, 'first')).toThrow('idempotency')
  })
  it('requires admission and fences replaced workers without losing retained samples', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(() => store.claim(run.id, 1000, () => {
      throw new Error('Unqualified build')
    })).toThrow('Unqualified build')
    expect(store.get(run.id).state).toBe('pending')
    const old = store.claim(run.id, 1000, () => undefined)
    store.append(old, sample())
    advance(1000)
    expect(() => store.append(old, sample(1))).toThrow('Stale')
    const current = store.claim(run.id, 1000, () => undefined)
    expect(() => store.renew(old, 1000)).toThrow('Stale')
    expect(() => store.finish(old, 'completed', 'stale')).toThrow('Stale')
    expect(store.append(current, sample(1))).toEqual({ state: 'recorded' })
    expect(store.get(run.id).point_count).toBe(2)
  })
  it('limits concurrent workers per side but permits the other side', () => {
    const { store } = setup()
    const first = store.create(plan, 'first'), second = store.create(plan, 'second'), right = store.create({ ...plan, side: 'right' }, 'right')
    store.claim(first.id, 1000, () => undefined)
    expect(() => store.claim(second.id, 1000, () => undefined)).toThrow('Side already')
    expect(store.claim(right.id, 1000, () => undefined).runId).toBe(right.id)
  })
  it('rejects configuration changes, duplicate metrics, future points, reordered points and altered retries', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    for (const invalid of [{ ...sample(), side: 'right' }, { ...sample(), candidateConfigHash: 'f'.repeat(64) }, { ...sample(), activeConfigHash: 'f'.repeat(64) },
      { ...sample(), timestampMs: start - 1 }, { ...sample(), timestampMs: start + 1 }, { ...sample(), readings: [...sample().readings, ...sample().readings] }]) {
      expect(() => store.append(lease, invalid)).toThrow('frozen plan')
    }
    store.append(lease, sample())
    expect(() => store.append(lease, { ...sample(), inputHash: 'f'.repeat(64) })).toThrow('idempotency')
    advance(100)
    expect(() => store.append(lease, sample(2))).toThrow('Out-of-order')
    expect(() => store.append(lease, { ...sample(1), timestampMs: start })).toThrow('Out-of-order')
  })
  it('atomically stops at per-run and global quotas and keeps stored evidence', () => {
    const { store, advance } = setup({ maximumRuns: 2, maximumPoints: 3, maximumBytes: 100000 })
    const first = store.create({ ...plan, maximumPoints: 1 }, 'first'), second = store.create({ ...plan, side: 'right' }, 'second')
    expect(() => store.create(plan, 'third')).toThrow('run quota')
    const lease = store.claim(first.id, 10000, () => undefined)
    const other = store.claim(second.id, 10000, () => undefined)
    store.append(lease, sample())
    advance(1)
    expect(store.append(lease, sample(1))).toEqual({ state: 'quota_reached' })
    expect(store.get(first.id)).toMatchObject({ state: 'stopped', reason: 'storage_quota', point_count: 1 })
    store.append(other, { ...sample(), side: 'right' })
    store.append(other, { ...sample(1), side: 'right' })
    advance(1)
    expect(store.append(other, { ...sample(2), side: 'right' })).toEqual({ state: 'quota_reached' })
    expect(store.get(second.id).point_count).toBe(2)
  })
  it('can cancel after deadline and cannot accept asynchronous admission', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(() => store.claim(run.id, 1000, async () => undefined)).toThrow('synchronously')
    expect(store.get(run.id).state).toBe('pending')
    const lease = store.claim(run.id, 1000, () => undefined)
    store.append(lease, sample())
    advance(60000)
    expect(() => store.renew(lease, 1000)).toThrow('Stale')
    expect(store.stop(run.id, 'window_elapsed')).toMatchObject({ state: 'stopped', reason: 'window_elapsed', point_count: 1 })
    expect(store.stop(run.id, 'retry')).toMatchObject({ reason: 'window_elapsed' })
    expect(() => store.claim(run.id, 1000, () => undefined)).toThrow('unavailable')
  })
  it('reports dropped candidate values, common reference support and current worker health', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    const first = sample()
    first.readings[0].candidate = { value: 61, quality: 1 }
    store.append(lease, first)
    advance(1000)
    store.append(lease, { ...sample(1), timestampMs: start + 1000 })
    const reference = { subjectId: 'fixture', side: 'left', source: 'test', rows: [0, 1000].map((offset, index) => ({
      recordKey: String(index), metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: start + offset })) }
    const report = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 }, reference)
    expect(report).toMatchObject({ expectedSlots: 2, observedSamples: 2, health: 'issues_detected', issues: ['coverage_degraded'],
      metrics: [{ candidate: { coverage: 0.5, usableCount: 1 }, current: { coverage: 1 }, coverageDifference: -0.5,
        comparison: { commonObservationCount: 1, lostObservationTimestamps: 1 } }] })
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/)
    advance(10000)
    expect(report.contextEvidence).toBe('host_observations_not_live_processor_cache_attestation')
    const stale = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(stale.issues).toEqual(expect.arrayContaining(['worker_stale', 'observation_gap']))
  })
  it('does not inflate coverage from bursts within one cadence slot', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    for (let index = 0; index < 3; index++) {
      const point = sample(index)
      point.readings[0].candidate = { value: 60, quality: 1 }
      store.append(lease, point)
      advance(1)
    }
    advance(1997)
    const report = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(report).toMatchObject({ expectedSlots: 3, metrics: [{ candidate: { usableCount: 3, usableSlots: 1, coverage: 1 / 3 } }] })
  })
  it('requires matching reference identity and never compares RMSSD to the variability index', () => {
    const { store } = setup()
    const lease = store.claim(store.create({ ...plan, metrics: ['window_ibi_variability_v1'], windowIbiWindowMs: 300000 }, 'first').id, 10000, () => undefined)
    store.append(lease, { ...sample(), readings: [{ metric: 'window_ibi_variability_v1', active: { value: 20, quality: 1 }, candidate: { value: 20, quality: 1 } }] })
    const reference = { subjectId: 'fixture', side: 'left', source: 'test', rows: [{ recordKey: '0', metric: 'hrv_rmssd', value: 20, unit: 'ms', windowMs: 300000, timestampMs: start }] }
    const limits = { maximumPoints: 10, maximumBytes: 10000 }
    expect(reportShadowRun(store, lease.runId, limits, reference).metrics[0]).toMatchObject({
      referenceExclusions: { incompatible_metric_definition: 1 }, comparison: { commonSupport: { candidate: { status: 'incompatible', metrics: null } } },
    })
    expect(() => reportShadowRun(store, lease.runId, limits, { ...reference, subjectId: 'other' })).toThrow('subject or side')
    expect(() => reportShadowRun(store, lease.runId, limits, { ...reference, side: 'right' })).toThrow('subject or side')
    expect(() => store.create({ ...plan, metrics: ['window_ibi_variability_v1'] }, 'invalid')).toThrow()
  })
  it('refuses oversized or corrupted snapshots instead of scoring partial history', () => {
    const { db, store } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    store.append(lease, sample())
    expect(() => store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 1 })).toThrow('input limit')
    db.prepare('UPDATE biometric_shadow_samples SET content_hash = ? WHERE run_id = ?').run('f'.repeat(64), lease.runId)
    expect(() => store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 })).toThrow('integrity')
  })
  it('reports clock skew and missing observations without converting unknown values to zero', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(reportShadowRun(store, run.id, { maximumPoints: 10, maximumBytes: 10000 }).issues).toContain('no_observations')
    const lease = store.claim(run.id, 10000, () => undefined)
    store.append(lease, sample())
    advance(-1)
    expect(reportShadowRun(store, run.id, { maximumPoints: 10, maximumBytes: 10000 })).toMatchObject({
      health: 'issues_detected', issues: expect.arrayContaining(['clock_skew']), metrics: [{ candidate: { coverage: null } }],
    })
  })
  it('bridges typed worker readings with exact active identity and preserves missing data and limitations', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 1000, () => undefined)
    const sink = new ShadowWorkerSink(store, lease)
    const output = { sequence: 0, inputHash: hash, side: 'left', sourceSide: 'right', timestampMs: start, configHash: hash,
      readings: [{ metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 60, quality: 1 },
        { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: 15, quality: 1 },
        { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 }],
      flags: null, limitations: ['cold_start_without_serialized_state'] }
    const active = { side: 'left', timestampMs: start, configHash: plan.activeConfigHash, readings: output.readings }
    for (const changed of [{ ...active, side: 'right' }, { ...active, timestampMs: start + 1 }, { ...active, configHash: hash }]) {
      expect(() => sink.append(output, changed)).toThrow('not contemporaneous')
    }
    expect(store.get(lease.runId).point_count).toBe(0)
    expect(sink.append(output, null)).toEqual({ state: 'recorded' })
    expect(sink.append(output, null)).toEqual({ state: 'already_recorded' })
    const snapshot = store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(snapshot.samples[0]).toMatchObject({ readings: [{ active: { value: null, quality: 0 }, candidate: { value: 60 } }],
      candidateProvenance: { sourceSide: 'right', limitations: expect.arrayContaining(['missing_contemporaneous_active_reading']) } })
    expect(reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).limitations).toContain('cold_start_without_serialized_state')
    advance(1000)
    expect(() => sink.append({ ...output, sequence: 1, timestampMs: start + 1000 }, null)).toThrow('Stale')
  })
  it('retains active-only times so dropped candidate readings reduce reported coverage', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create({ ...plan, joining }, 'joined').id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    for (const offset of [2000, 0, 1000]) join.active(activeOutput(start + offset))
    join.candidate(workerOutput(start + 1000))
    advance(2999)
    expect(join.advance(start + 2999)).toEqual({ emitted: 2, stopped: false })
    advance(1)
    expect(join.advance(start + 3000)).toEqual({ emitted: 1, stopped: false })
    const report = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(report).toMatchObject({ pairing: { activeOnly: 2, candidateOnly: 0, unknownInputIdentity: 2 },
      metrics: [{ current: { usableCount: 3 }, candidate: { usableCount: 1 }, issues: expect.arrayContaining(['coverage_regression']) }] })
    const points = store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).samples
    expect(points.map(row => row.timestampMs)).toEqual([start, start + 1000, start + 2000])
    expect(points[0]).toMatchObject({ inputHash: null, inputIdentityKind: 'unavailable', readings: [{ candidate: { value: null } }] })
  })
  it('does not match nearby timestamps and fails explicitly on late or conflicting arrivals', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create({ ...plan, joining }, 'joined').id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    join.active(activeOutput(start))
    join.active(activeOutput(start))
    join.candidate(workerOutput(start + 1))
    advance(1001)
    expect(join.advance(start + 1001).emitted).toBe(2)
    expect(reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).pairing).toMatchObject({ activeOnly: 1, candidateOnly: 1 })
    expect(() => join.candidate(workerOutput(start))).toThrow('join_late_arrival')
    expect(store.get(lease.runId)).toMatchObject({ state: 'failed', reason: 'join_late_arrival' })
    const nextPlan = { ...plan, startMs: start + 1001, joining }
    const secondLease = store.claim(store.create(nextPlan, 'second').id, 10000, () => undefined)
    const second = new ShadowStreamJoin(store, secondLease)
    second.active(activeOutput(start + 1001))
    const changed = activeOutput(start + 1001)
    changed.readings[0].value = 80
    expect(() => second.active(changed)).toThrow('join_conflicting_duplicate')
  })
  it('bounds pending points and preserves uncertain-write retry identity', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create({ ...plan, joining: { ...joining, maximumPendingPoints: 1 } }, 'joined').id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    join.active(activeOutput(start))
    join.candidate(workerOutput(start))
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementationOnce((lease, point) => {
      append(lease, point)
      throw new Error('lost acknowledgment')
    })
    advance(1000)
    expect(() => join.advance(start + 1000)).toThrow('lost acknowledgment')
    expect(store.get(lease.runId).point_count).toBe(1)
    expect(join.advance(start + 1000).emitted).toBe(1)
    expect(store.get(lease.runId).point_count).toBe(1)
    join.active(activeOutput(start + 2000))
    expect(() => join.active(activeOutput(start + 3000))).toThrow('join_queue_quota')
  })
  it('drains final buffered samples during explicit grace without extending the sampling window', () => {
    const { store, advance } = setup()
    const selected = { ...plan, endMs: start + 5000, joining }
    const run = store.create(selected, 'joined')
    const lease = store.claim(run.id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    join.active(activeOutput(start + 4999))
    advance(6000)
    expect(join.advance(start + 6000)).toEqual({ emitted: 1, stopped: false })
    expect(store.get(run.id).point_count).toBe(1)
    store.renew(lease, 10000)
    expect(store.get(run.id).lease_until_ms).toBe(start + 7000)
    advance(1000)
    expect(() => store.renew(lease, 10000)).toThrow('Stale')
  })
  it('enforces byte quotas and terminal states', () => {
    const { store } = setup()
    const lease = store.claim(store.create({ ...plan, maximumBytes: 1 }, 'first').id, 1000, () => undefined)
    expect(store.append(lease, sample()).state).toBe('quota_reached')
    expect(() => store.append(lease, sample())).toThrow('Stale')
    const next = store.claim(store.create(plan, 'second').id, 1000, () => undefined)
    store.finish(next, 'failed', 'processor_failure')
    expect(store.get(next.runId)).toMatchObject({ state: 'failed', reason: 'processor_failure' })
    expect(() => store.renew(next, 1000)).toThrow('Stale')
  })
})
