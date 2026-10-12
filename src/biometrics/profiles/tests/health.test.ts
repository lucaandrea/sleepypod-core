import { describe, expect, it } from 'vitest'
import { runtimeHealth } from '../health'
const now = 1791673200000
const receipts = () => ['heart_rate', 'breathing_rate', 'hrv_index'].map(component => ({ component,
  generation: 2, appliedHash: 'bundle', state: 'applied', effectiveSampleTimeMs: now - 50000, heartbeatAtMs: now - 30000 }))
describe('continuous processor health is distinct from historical adoption', () => {
  it('requires all three numerical consumers and ignores on-demand stage receipt age', () => {
    expect(runtimeHealth([], now).state).toBe('unreported')
    expect(runtimeHealth(receipts().slice(1), now).state).toBe('unreported')
    expect(runtimeHealth([...receipts(), { ...receipts()[0], component: 'sleep_stages', heartbeatAtMs: 0 }], now).state).toBe('current')
  })
  it('reports stopped processors, future clocks, failure and incomplete application', () => {
    expect(runtimeHealth(receipts(), now + 120000).state).toBe('stale')
    expect(runtimeHealth(receipts(), now - 60000).state).toBe('clock_skew')
    expect(runtimeHealth(receipts().map(row => ({ ...row, state: 'failed' })), now).state).toBe('failed')
    expect(runtimeHealth(receipts().map(row => ({ ...row, effectiveSampleTimeMs: null })), now).state).toBe('unreported')
  })
  it('does not call different generations or hashes one coherent current profile', () => {
    const rows = receipts()
    rows[1].generation = 3
    expect(runtimeHealth(rows, now).state).toBe('mixed_generations')
    rows[1].generation = 2
    rows[1].appliedHash = 'other'
    expect(runtimeHealth(rows, now).state).toBe('mixed_generations')
    rows[1] = { ...rows[0], component: 'breathing_rate' }
    expect(runtimeHealth([{ ...rows[0], generation: 1, heartbeatAtMs: now }, ...rows], now).state).toBe('current')
  })
})
