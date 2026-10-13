// @vitest-environment node
import { expect, it } from 'vitest'
import { verifyReplayContext, replayContextQualificationSchema } from '../replay-context'
import { replayContextFixture } from './fixtures/replay-context'
import { dataHash } from '../../algorithms/canonical'
const expected = { cohortIds: ['a', 'b'], configHashes: ['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)],
  pythonBuildHash: 'c'.repeat(64), otherSideConfigHash: 'e'.repeat(64), side: 'left' as const }
const qualified = { allowedLimitations: ['event_time_replaces_arrival_time' as const] }
const fixture = () => replayContextFixture(expected.cohortIds, expected.configHashes, expected.pythonBuildHash, expected.otherSideConfigHash)
it('audits exact distinct cohort/configuration outputs and explicitly accepted approximations', () => {
  expect(verifyReplayContext(fixture(), expected, qualified)).toEqual({ version: 'qualified-replay-context-v1',
    outputs: 4, observedLimitations: ['event_time_replaces_arrival_time'], allowedLimitations: ['event_time_replaces_arrival_time'] })
  expect(() => verifyReplayContext(fixture(), expected, null)).toThrow('not been qualified')
})
it.each(['missing_pump_context', 'missing_occupancy_context', 'missing_sleeper_mode', 'less_than_five_minutes_preroll',
  'cold_start_without_serialized_state', 'future_unknown_limitation'])('rejects unqualified %s in run or individual reading diagnostics', (code) => {
  for (const reading of [true, false]) {
    const work = fixture()
    if (reading) work.outputs[3].readings[0].limitations.push(code)
    else work.outputs[3].run.limitations.push(code)
    work.hash = dataHash(work.outputs)
    expect(() => verifyReplayContext(work, expected, qualified)).toThrow(`Unqualified replay limitation: ${code}`)
  }
})
it('rejects missing, duplicate, altered and inconsistent output identities', () => {
  for (const change of [
    (work: ReturnType<typeof fixture>) => { work.outputs.pop() },
    (work: ReturnType<typeof fixture>) => { work.outputs[3] = work.outputs[0] },
    (work: ReturnType<typeof fixture>) => { work.outputs[0].cohortId = 'unknown' },
    (work: ReturnType<typeof fixture>) => { work.outputs[0].run.build_hash = 'f'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.outputs[0].run.config_hashes.right = 'f'.repeat(64) },
    (work: ReturnType<typeof fixture>) => { work.outputs[0].run.counts.scored_outputs = 2 },
    (work: ReturnType<typeof fixture>) => { work.outputs[0].readings[0].configHash = 'f'.repeat(64) },
  ]) {
    const work = fixture()
    change(work)
    work.hash = dataHash(work.outputs)
    expect(() => verifyReplayContext(work, expected, qualified)).toThrow()
  }
  expect(() => verifyReplayContext({ ...fixture(), hash: 'f'.repeat(64) }, expected, qualified)).toThrow('content hash')
})

it('accepts only explicitly designated known limitations and records the observed subset', () => {
  const work = fixture()
  work.outputs[0].run.limitations.push('cold_start_without_serialized_state')
  work.hash = dataHash(work.outputs)
  const qualification = replayContextQualificationSchema.parse({ allowedLimitations: [
    'event_time_replaces_arrival_time', 'cold_start_without_serialized_state', 'less_than_five_minutes_preroll',
  ] })
  expect(verifyReplayContext(work, expected, qualification)).toMatchObject({ observedLimitations: [
    'cold_start_without_serialized_state', 'event_time_replaces_arrival_time',
  ] })
  for (const allowedLimitations of [['unknown_future_code'], ['missing_pump_context', 'missing_pump_context']]) {
    expect(replayContextQualificationSchema.safeParse({ allowedLimitations }).success).toBe(false)
  }
})
