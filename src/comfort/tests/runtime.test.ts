import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Side } from '@/src/hardware/types'
import { withSideLock } from '@/src/hardware/sideLock'
import { ComfortRuntime, type ComfortRuntimeDeps } from '../runtime'
import { createComfortStore } from '../store'
import { defaultComfortState, MANUAL_PAUSE_MS, type ComfortContext } from '../policy'
import { migratedComfortDatabase } from './databaseFixture'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => {
  databases.splice(0).forEach(database => database.close())
  vi.useRealTimers()
})

function harness() {
  const database = migratedComfortDatabase()
  databases.push(database)
  const now = Date.parse('2026-10-25T10:00:00Z')
  const store = createComfortStore(database)
  const input: ComfortContext = {
    now, window: { session: 'night-1', segment: 'night-1:bedtime', start: now - 3_600_000, end: now + 3_600_000, baselineF: 75, alarmAt: null },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
    presence: { observedAt: now, available: true, occupied: true },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
  }
  const pending: Partial<Record<Side, number>> = {}
  const deps: ComfortRuntimeDeps = {
    now: () => input.now, store, withSideLock,
    readContext: () => ({ context: input, timezone: 'America/Los_Angeles' }),
    timezone: () => 'America/Los_Angeles',
    pendingPause: side => pending[side] ?? null,
    acknowledgePause: (side) => { pending[side] = undefined },
  }
  store.commit('left', { ...defaultComfortState(), offsetF: -2, config: { mode: 'preview', minimumF: 70, maximumF: 95 } })
  return { database, input, deps, store, pending, runtime: new ComfortRuntime(deps) }
}

describe('production personal comfort Preview', () => {
  it('does not present an old eligible decision after a manual pause changes persisted state', async () => {
    const { runtime, store, input } = harness()
    await runtime.evaluate('left')
    expect(runtime.status('left').decision?.eligible).toBe(true)
    store.commit('left', { ...store.read('left'), pausedUntil: input.now + MANUAL_PAUSE_MS })
    expect(runtime.status('left')).toMatchObject({ decision: null, state: { pausedUntil: input.now + MANUAL_PAUSE_MS } })
  })
  it('records a bounded proposal with measurement times without claiming an applied target', async () => {
    const { runtime, store, input } = harness()
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({
      evaluatedAt: input.now, decision: { eligible: true, proposedF: 74 },
      activation: { available: false }, state: { lastAppliedAt: 0, lastTargetF: null },
    })
    expect(store.history('left')[0]).toMatchObject({ kind: 'preview', proposedF: 74, reportedF: 75, owner: 'schedule', deviceObservedAt: input.now })
  })

  it('rejects active and unsupported adapter settings, retaining existing consent', async () => {
    const { runtime, store } = harness()
    const config = store.read('left').config
    await expect(runtime.configure('left', { ...config, mode: 'active' })).rejects.toThrow('qualification')
    await expect(runtime.configure('left', { ...config, sensorAware: true })).rejects.toThrow('qualified')
    await expect(runtime.configure('left', { ...config, followBedtime: true })).rejects.toThrow('qualified')
    expect(store.read('left').config).toEqual(config)
  })

  it('keeps migrated active settings inert and reports the missing qualification', async () => {
    const { runtime, store } = harness()
    const state = store.read('left')
    store.commit('left', { ...state, config: { ...state.config, mode: 'active' } })
    await runtime.evaluate('left')
    expect(runtime.status('left').decision).toMatchObject({ eligible: false, proposedF: null, reason: expect.stringContaining('qualification') })
  })

  it('persists an unexpected-target pause across a new runtime and configuration changes', async () => {
    const { runtime, deps, input, store } = harness()
    input.targetKnown = false
    await runtime.evaluate('left')
    expect(store.read('left').pausedUntil).toBe(input.now + MANUAL_PAUSE_MS)
    input.targetKnown = true
    const restarted = new ComfortRuntime(deps)
    await restarted.configure('left', { mode: 'preview', minimumF: 70, maximumF: 95 })
    await restarted.evaluate('left')
    expect(restarted.status('left').decision).toMatchObject({ eligible: false, reason: expect.stringContaining('six hours') })
  })

  it('recovers a failed manual journal before evaluating another proposal', async () => {
    const { runtime, pending, input, store } = harness()
    pending.left = input.now - 60_000
    await runtime.evaluate('left')
    expect(pending.left).toBeUndefined()
    expect(store.read('left').pausedUntil).toBe(input.now - 60_000 + MANUAL_PAUSE_MS)
    expect(runtime.status('left').decision?.eligible).toBe(false)
  })

  it('withholds when journal writes fail, without acknowledging a proposal or consuming check-ins', async () => {
    const { runtime, database, store } = harness()
    database.exec('CREATE TRIGGER reject_comfort BEFORE INSERT ON comfort_events BEGIN SELECT RAISE(ABORT, \'test\'); END')
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({ decision: null, fault: expect.stringContaining('journal') })
    expect(store.read('left').learnedSession).toBe('')
    database.exec('DROP TRIGGER reject_comfort')
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({ fault: null, decision: { eligible: true } })
  })

  it('uses three unique check-ins once and preserves learning cursors across restart', async () => {
    const { runtime, store, deps } = harness()
    for (const date of ['2026-10-23', '2026-10-24', '2026-10-25']) await runtime.feedback('left', { date, comfort: 'warm' })
    await runtime.evaluate('left')
    expect(store.read('left')).toMatchObject({ offsetF: -3, feedbackThrough: '2026-10-25', learnedSession: 'night-1' })
    await new ComfortRuntime(deps).evaluate('left')
    expect(store.read('left').offsetF).toBe(-3)
  })

  it('validates feedback dates in the device timezone and leaves consumed edits consumed', async () => {
    const { runtime, input, store } = harness()
    input.now = Date.parse('2026-10-25T01:00:00Z') // Still October 24 in Los Angeles.
    await expect(runtime.feedback('left', { date: '2026-10-25', comfort: 'cold' })).rejects.toThrow('local dates')
    await expect(runtime.feedback('left', { date: '2026-10-01', comfort: 'warm' })).rejects.toThrow('local dates')
    const state = store.read('left')
    store.commit('left', { ...state, feedbackThrough: '2026-10-24' })
    await runtime.feedback('left', { date: '2026-10-24', comfort: 'cold' })
    expect(store.read('left').feedbackThrough).toBe('2026-10-24')
  })

  it('records changed guards immediately and limits unchanged observations to once a minute', async () => {
    const { runtime, input, store } = harness()
    await runtime.evaluate('left')
    await runtime.evaluate('left')
    expect(store.history('left')).toHaveLength(1)
    input.device.priming = true
    await runtime.evaluate('left')
    expect(store.history('left')).toHaveLength(2)
    input.now += 60_000
    input.device.observedAt = input.now
    input.presence.observedAt = input.now
    await runtime.evaluate('left')
    expect(store.history('left')).toHaveLength(3)
  })

  it('runs without overlapping ticks and drains queued work before shutdown', async () => {
    vi.useFakeTimers()
    const { runtime, store } = harness()
    await runtime.start()
    await vi.advanceTimersByTimeAsync(15_000)
    await runtime.stop()
    const before = store.history('left')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.status('left').runtime).toBe('stopped')
    expect(store.history('left')).toEqual(before)
  })
})
