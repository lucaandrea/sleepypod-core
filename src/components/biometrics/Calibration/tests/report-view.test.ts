// @vitest-environment node
import { expect, it } from 'vitest'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { backtestFixture } from '@/src/biometrics/backtest/tests/fixtures/backtest'
import { reportViewSchema } from '../report-view'

it('accepts actual stage and stored-reading reports without retaining detailed traces in the summary projection', () => {
  const input = backtestFixture()
  const stage = reportViewSchema.parse(evaluateBacktest(input))
  expect(stage.stageNightSummary[0].equalNightMeanAgreementDifference).toBe(0)
  expect(stage).not.toHaveProperty('nights')
  const protocol = { ...input.job.protocol, mode: 'comparison' as const }
  const comparison = reportViewSchema.parse(evaluateBacktest({ ...input, job: { ...input.job, protocol, protocolHash: configHash(protocol) } }))
  expect(comparison.protocol.mode).toBe('comparison')
  expect(comparison.stageNightSummary).toEqual([])
})
