import { beforeEach, expect, it } from 'vitest'
import { submissionFixture } from '@/src/biometrics/shadow/tests/fixtures/submission'
import { readShadowScheduleRecovery, saveShadowScheduleRecovery, clearShadowScheduleRecovery } from '../shadow-schedule-recovery'
const value = () => ({ version: 1 as const, prepared: { status: 'prepared_not_admitted' as const, plan: submissionFixture().plan, planHash: 'b'.repeat(64) }, idempotencyKey: 'c'.repeat(48) })
beforeEach(() => sessionStorage.clear())
it('round-trips exact requests with isolated per-side keys and clears confirmed intent', () => {
  const original = value()
  saveShadowScheduleRecovery(sessionStorage, 'left', original)
  expect(readShadowScheduleRecovery(sessionStorage, 'left')).toEqual(original)
  expect(readShadowScheduleRecovery(sessionStorage, 'right')).toBeUndefined()
  saveShadowScheduleRecovery(sessionStorage, 'left', original)
  clearShadowScheduleRecovery(sessionStorage, 'left')
  expect(readShadowScheduleRecovery(sessionStorage, 'left')).toBeUndefined()
})
it('refuses to replace unresolved intent or save a different side', () => {
  const original = value()
  saveShadowScheduleRecovery(sessionStorage, 'left', original)
  expect(() => saveShadowScheduleRecovery(sessionStorage, 'left', { ...original, idempotencyKey: 'd'.repeat(48) })).toThrow('Unresolved')
  expect(() => saveShadowScheduleRecovery(sessionStorage, 'right', original)).toThrow('Invalid')
  expect(readShadowScheduleRecovery(sessionStorage, 'left')).toEqual(original)
})
it('rejects corrupt, oversized, mismatched-side and invalid-window persisted records without deleting them', () => {
  const original = value()
  const records = ['{bad', 'x'.repeat(65537), JSON.stringify({ ...original, prepared: { ...original.prepared, plan: { ...original.prepared.plan, side: 'right' } } }),
    JSON.stringify({ ...original, prepared: { ...original.prepared, plan: { ...original.prepared.plan, startMs: 9000000000000000, endMs: 9000000000000001 } } })]
  for (const text of records) {
    sessionStorage.setItem('sleepypod.shadow-schedule.v1.left', text)
    expect(() => readShadowScheduleRecovery(sessionStorage, 'left')).toThrow()
    expect(sessionStorage.getItem('sleepypod.shadow-schedule.v1.left')).toBe(text)
  }
})
