// @vitest-environment node
import { expect, it } from 'vitest'
import { pageStageTraces } from '../traces'
const request = { id: '11111111-1111-4111-8111-111111111111', expectedContentHash: 'a'.repeat(64), configuration: 'candidate' as const, limit: 2 }
const report = { version: 'processed-backtest-report-v1', protocol: { mode: 'stage_replay', clockOffsetMs: 60000 }, nights: ['one', 'two'].map((cohortId, index) => ({
  cohortId, evaluations: [{ label: 'candidate', configHash: 'b'.repeat(64), revisionId: null, windows: [{ startMs: index * 300, endMs: index * 300 + 300,
    blocks: [0, 1, 2].map(i => ({ start: index * 300 + i * 100, end: index * 300 + (i + 1) * 100, stage: 'light' })) }] }],
})) }
it('pages every retained interval exactly once with a stable hash cursor and no timestamp offset', () => {
  const before = JSON.stringify(report)
  const first = pageStageTraces(report, request)
  const second = pageStageTraces(report, { ...request, offset: first.nextCursor?.offset })
  const third = pageStageTraces(report, { ...request, offset: second.nextCursor?.offset })
  expect(first).toMatchObject({ totalItems: 6, downsampled: false, clockOffsetMs: 60000, nextCursor: { offset: 2, contentHash: request.expectedContentHash } })
  expect([...first.items, ...second.items, ...third.items].map(row => row.startMs)).toEqual([0, 100, 200, 300, 400, 500])
  expect(third.nextCursor).toBeNull()
  expect(pageStageTraces(report, { ...request, offset: 6 }).items).toEqual([])
  expect(JSON.stringify(report)).toBe(before)
})
it('filters the cohort before counting and rejects out-of-range or missing selections', () => {
  expect(pageStageTraces(report, { ...request, cohortId: 'two' })).toMatchObject({ totalItems: 3, items: [{ cohortId: 'two' }, { cohortId: 'two' }] })
  expect(() => pageStageTraces(report, { ...request, cohortId: 'missing' })).toThrow('not evaluated')
  expect(() => pageStageTraces(report, { ...request, configuration: 'default' })).toThrow('not evaluated')
  expect(() => pageStageTraces(report, { ...request, offset: 7 })).toThrow('cursor')
  expect(() => pageStageTraces(report, { ...request, limit: 501 })).toThrow()
  expect(() => pageStageTraces({ ...report, protocol: { ...report.protocol, mode: 'comparison' } }, request)).toThrow('did not produce')
})
