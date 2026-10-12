// @vitest-environment node
import { expect, it } from 'vitest'
import { evaluateBacktest } from '../evaluator'
import { dataHash } from '../../algorithms/canonical'
import { backtestFixture } from './fixtures/backtest'
import { summarizeBacktestResult } from '../report-summary'
import { pageStageTraces } from '../trace-page'

it('preserves all scores and the retained artifact hash while omitting trace rows', () => {
  const report = evaluateBacktest(backtestFixture())
  const contentHash = dataHash(report)
  const descriptor = { report, available: true, contentHash }
  const summary = summarizeBacktestResult(descriptor)
  if (!summary) throw new Error('Expected a summary')
  expect(summary).toMatchObject({ contentHash, contentHashScope: 'complete_retained_report', projection: 'scores_without_stage_trace_rows_v1' })
  const expected = structuredClone(report) as unknown as { nights: Array<{ evaluations: Array<{ windows: Array<{ blocks?: unknown }> }> }> }
  for (const night of expected.nights) {
    for (const evaluation of night.evaluations) {
      for (const window of evaluation.windows) delete window.blocks
    }
  }
  expect(summary.report).toEqual(expected)
  expect(dataHash(report)).toBe(contentHash)
  expect(pageStageTraces(report, { id: '11111111-1111-4111-8111-111111111111', expectedContentHash: contentHash, configuration: 'default' }).totalItems).toBeGreaterThan(0)
  expect(JSON.stringify(summary.report).length).toBeLessThan(JSON.stringify(report).length)
})
it('distinguishes missing and released reports without manufacturing content', () => {
  expect(summarizeBacktestResult(null)).toBeNull()
  expect(summarizeBacktestResult({ available: false, report: null, contentHash: 'retained' })).toMatchObject({ report: null, available: false, contentHash: 'retained' })
})
it('rejects unknown versions and oversize scores instead of silently truncating them', () => {
  expect(() => summarizeBacktestResult({ available: true, report: { version: 'future' } })).toThrow('summary format')
  expect(() => summarizeBacktestResult({ available: true, report: { version: 'processed-backtest-report-v1', nights: [], extra: 'x'.repeat(2 * 1024 * 1024) } })).toThrow('transport limit')
})
