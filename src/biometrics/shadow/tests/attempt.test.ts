// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'
import { ShadowStore } from '../store'
import { runShadowAttempt, type ShadowAttemptHost } from '../attempt'

const worker = vi.hoisted(() => ({ calls: 0, cleaned: false, fail: false }))
vi.mock('../worker-child', () => ({ runShadowChild: async (_location: unknown, init: { side: string, configHashes: Record<string, string> }, frames: AsyncIterable<{ observedAtMs: number }>, output: (row: unknown) => void) => {
  worker.calls++
  try {
    let sequence = 0
    for await (const frame of frames) {
      if (worker.fail) throw new Error('processor_failed')
      output({ side: init.side, sourceSide: init.side, timestampMs: frame.observedAtMs, configHash: init.configHashes[init.side], sequence: sequence++,
        inputHash: 'a'.repeat(64), flags: null, limitations: [], readings: [
          { metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 60, quality: 1 },
          { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: 12, quality: 1 },
          { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 },
        ] })
    }
    return { health: { state: 'completed' } }
  }
  finally { worker.cleaned = true }
} }))
const start = 1700000000000, hash = configHash(defaultConfig)
const databases: Database.Database[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  worker.calls = 0
  worker.cleaned = false
  worker.fail = false
})
afterEach(() => {
  vi.useRealTimers()
  databases.splice(0).forEach(db => db.close())
})
function setup(maximumPoints = 10, duration = 2000) {
  const db = new Database(':memory:')
  databases.push(db)
  migrate(drizzle(db), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
  const store = new ShadowStore(db, { maximumRuns: 10, maximumPoints: 100, maximumBytes: 100000 })
  const run = store.create({ schema: 'biometric-shadow-plan-v1', subjectId: 'test', side: 'left', startMs: start, endMs: start + duration,
    candidateConfigHash: hash, activeConfigHash: hash, qualificationHash: 'c'.repeat(64), engineBuildHash: 'd'.repeat(64),
    maximumPoints, maximumBytes: 10000, metrics: ['heart_rate'], joining: { maximumPendingPoints: 10, maximumLatenessMs: 100, drainGraceMs: 500 },
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 1000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }, 'test')
  let active: (reading: unknown) => void = () => {
    throw new Error('Sources not open')
  }
  const close = vi.fn()
  const host: ShadowAttemptHost = {
    location: { pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, configs: { left: defaultConfig, right: defaultConfig },
    maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
    budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 10000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
    leaseMs: 1500, heartbeatMs: 200, admit: vi.fn(),
    openSources: (input) => {
      active = input.active
      let sent = false
      return { close, frames: { [Symbol.asyncIterator]: () => ({ next: () => {
        if (sent) return new Promise<IteratorResult<unknown>>(() => {})
        sent = true
        return Promise.resolve({ done: false, value: { type: 'frame', observedAtMs: start } })
      } }) } }
    },
  }
  return { db, store, run, host, close, active: (timestampMs = start) => active({ side: 'left', timestampMs, configHash: hash,
    readings: [{ metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 61, quality: 1 },
      { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: 12, quality: 1 },
      { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 }] }) }
}
describe('leased shadow attempt lifecycle', () => {
  it('retains both streams, renews the lease and completes only after final drain', async () => {
    const { db, store, run, host, close, active } = setup()
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER deny_${operation} BEFORE ${operation} ON vitals BEGIN SELECT RAISE(ABORT, 'canonical write forbidden'); END`)
    const task = runShadowAttempt(store, run.id, host)
    await vi.advanceTimersByTimeAsync(0)
    active()
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.get(run.id).state).toBe('running')
    expect(worker.cleaned).toBe(true)
    active(start + 1999)
    await vi.advanceTimersByTimeAsync(101)
    expect((await task).run).toMatchObject({ state: 'completed', point_count: 2, reason: 'observation_window_complete' })
    const sample = store.snapshot(run.id, { maximumPoints: 10, maximumBytes: 10000 }).samples[0]
    expect(sample).toMatchObject({ readings: [{ active: { value: 61 }, candidate: { value: 60 } }] })
    expect(close).toHaveBeenCalledOnce()
    expect(vi.mocked(host.admit).mock.calls.length).toBeGreaterThan(5)
  })
  it('rejects asynchronous admission without claiming or opening sources', async () => {
    const { store, run, host } = setup()
    host.admit = async () => {}
    await expect(runShadowAttempt(store, run.id, host)).rejects.toThrow(/synchronously/)
    expect(store.get(run.id).state).toBe('pending')
    expect(worker.calls).toBe(0)
  })
  it('cancels, waits for worker cleanup, and ignores late source callbacks', async () => {
    const { store, run, host, close, active } = setup()
    const abort = new AbortController()
    const task = runShadowAttempt(store, run.id, host, abort.signal)
    const rejected = expect(task).rejects.toThrow('shadow_cancelled')
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    await rejected
    expect(worker.cleaned).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(store.get(run.id)).toMatchObject({ state: 'stopped', reason: 'shadow_cancelled', point_count: 0 })
    active()
    expect(store.get(run.id).point_count).toBe(0)
  })
  it('rechecks binding/resource admission during observation', async () => {
    const { store, run, host } = setup()
    const task = runShadowAttempt(store, run.id, host)
    const rejected = expect(task).rejects.toThrow('shadow_admission_or_lease_lost')
    await vi.advanceTimersByTimeAsync(0)
    host.admit = () => {
      throw new Error('active binding changed')
    }
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(store.get(run.id)).toMatchObject({ state: 'failed', reason: 'shadow_admission_or_lease_lost' })
    expect(worker.cleaned).toBe(true)
  })
  it('never finishes or writes over a replacement attempt', async () => {
    const { store, run, host } = setup(10, 5000)
    const task = runShadowAttempt(store, run.id, host)
    const rejected = expect(task).rejects.toThrow(/lease_lost/)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(start + 1600)
    const replacement = store.claim(run.id, 1500, () => {})
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(store.get(run.id)).toMatchObject({ state: 'running', attempt_id: replacement.attemptId, point_count: 0 })
  })
  it('preserves storage-quota termination instead of marking completion', async () => {
    const { store, run, host, active } = setup(1)
    const task = runShadowAttempt(store, run.id, host)
    const rejected = expect(task).rejects.toThrow('storage_quota')
    await vi.advanceTimersByTimeAsync(1)
    active(start + 1)
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(store.get(run.id)).toMatchObject({ state: 'stopped', reason: 'storage_quota', point_count: 1 })
  })
  it('fails when the source ends before the prospective window', async () => {
    const { store, run, host, close } = setup()
    host.openSources = () => ({ close, frames: { async* [Symbol.asyncIterator]() {} } })
    await expect(runShadowAttempt(store, run.id, host)).rejects.toThrow('shadow_source_ended_early')
    expect(store.get(run.id).state).toBe('failed')
    expect(close).toHaveBeenCalledOnce()
  })
  it('retains a processor failure and cleans up both sources', async () => {
    const { store, run, host, close } = setup()
    worker.fail = true
    await expect(runShadowAttempt(store, run.id, host)).rejects.toThrow('processor_failed')
    expect(store.get(run.id)).toMatchObject({ state: 'failed', reason: 'processor_failed' })
    expect(close).toHaveBeenCalledOnce()
  })
})
it('records an expired attempt as failed only after worker cleanup', async () => {
  const { store, run, host } = setup(10, 5000)
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow(/lease_lost/)
  await vi.advanceTimersByTimeAsync(0)
  vi.setSystemTime(start + 1600)
  await vi.advanceTimersByTimeAsync(200)
  await rejected
  expect(worker.cleaned).toBe(true)
  expect(store.get(run.id)).toMatchObject({ state: 'failed', reason: 'shadow_admission_or_lease_lost' })
})
it('preserves an operator stop and reaps the attempt', async () => {
  const { store, run, host } = setup()
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow(/lease_lost/)
  await vi.advanceTimersByTimeAsync(0)
  store.stop(run.id, 'operator_stop')
  await vi.advanceTimersByTimeAsync(200)
  await rejected
  expect(worker.cleaned).toBe(true)
  expect(store.get(run.id)).toMatchObject({ state: 'stopped', reason: 'operator_stop' })
})
it('does not mark completion if source cleanup fails', async () => {
  const { store, run, host, close } = setup()
  close.mockImplementation(() => {
    throw new Error('unsubscribe failed')
  })
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow('shadow_source_cleanup_failed')
  await vi.advanceTimersByTimeAsync(2101)
  await rejected
  expect(store.get(run.id).state).toBe('failed')
})
it('refuses to finish an unexpired lease through expired-attempt recovery', () => {
  const { store, run } = setup()
  const lease = store.claim(run.id, 1500, () => {})
  expect(store.failExpired(lease, 'worker_gone')).toBe(false)
  expect(store.get(run.id).state).toBe('running')
})
it('stops immediately when the active source reports a disconnect', async () => {
  const { store, run, host } = setup()
  const open = host.openSources
  let disconnect = () => {}
  host.openSources = (input) => {
    disconnect = input.fail
    return open(input)
  }
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow('shadow_source_failed')
  await vi.advanceTimersByTimeAsync(0)
  disconnect()
  await rejected
  expect(worker.cleaned).toBe(true)
  expect(store.get(run.id)).toMatchObject({ state: 'failed', reason: 'shadow_source_failed' })
})
it('rechecks admission after cleanup before publishing completion', async () => {
  const { store, run, host, close } = setup()
  close.mockImplementation(() => {
    host.admit = () => {
      throw new Error('active profile changed during cleanup')
    }
  })
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow('shadow_admission_changed_before_completion')
  await vi.advanceTimersByTimeAsync(2101)
  await rejected
  expect(store.get(run.id).state).toBe('failed')
})
it('rejects future active timestamps before buffering them', async () => {
  const { store, run, host, active } = setup()
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow('shadow_active_stream_failed')
  await vi.advanceTimersByTimeAsync(0)
  active(start + 1)
  await rejected
  expect(store.get(run.id)).toMatchObject({ state: 'failed', point_count: 0 })
})
it('flushes active observations before sealing the final drain', async () => {
  const { store, run, host, active } = setup()
  const open = host.openSources
  let emitted = false
  host.openSources = input => ({ ...open(input), flush: () => {
    if (!emitted && Date.now() >= start + 2100) {
      active(start + 1999)
      emitted = true
    }
  } })
  const task = runShadowAttempt(store, run.id, host)
  await vi.advanceTimersByTimeAsync(2101)
  await task
  expect(store.get(run.id)).toMatchObject({ state: 'completed', point_count: 2 })
  expect(store.snapshot(run.id, { maximumPoints: 10, maximumBytes: 10000 }).samples[1]).toMatchObject({ timestampMs: start + 1999, pairing: { activePresent: true, candidatePresent: false } })
})
it('refuses asynchronous final-drain polling', async () => {
  const { store, run, host } = setup()
  const open = host.openSources
  host.openSources = input => ({ ...open(input), flush: async () => {} })
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow(/admission_or_lease_lost/)
  await vi.advanceTimersByTimeAsync(200)
  await rejected
  expect(store.get(run.id).state).toBe('failed')
})
it('records lease expiry during final cleanup as failure rather than leaving a running attempt', async () => {
  const { store, run, host, close } = setup()
  close.mockImplementation(() => {
    vi.setSystemTime(start + 3000)
  })
  const task = runShadowAttempt(store, run.id, host)
  const rejected = expect(task).rejects.toThrow(/Stale shadow lease/)
  await vi.advanceTimersByTimeAsync(2101)
  await rejected
  expect(store.get(run.id)).toMatchObject({ state: 'failed', reason: 'shadow_completion_lease_lost' })
})
