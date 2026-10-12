// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { configHash } from '../../algorithms/canonical'
import { classifySleepStages } from '@/src/lib/sleep-stages'
import { evaluateBacktest } from '../evaluator'

import { backtestFixture as fixture } from './fixtures/backtest'
const start = 1791673200000

describe('retained-data evaluator', () => {
  it('deduplicates overlapping sessions, preserves shared classifier behavior and does not mutate input', () => {
    const input = fixture(), before = JSON.stringify(input)
    const report = evaluateBacktest(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(report.nights[0].uniqueObservationCount).toBe(10)
    const windows = report.nights[0].evaluations[0].windows
    expect(windows).toEqual(report.nights[0].evaluations[1].windows)
    const expected = classifySleepStages(input.dataset.snapshot.sessions[0].vitals.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })), [], 0)
    expect(windows[0].blocks).toEqual(expected.map(epoch => ({ start: epoch.start, end: Math.min(start + 600000, epoch.start + epoch.duration), stage: epoch.stage })))
    expect(windows[0].stage).toMatchObject({ pairedDurationMs: 600000, agreement: 1 })
    expect(windows[0].numeric[0]).toMatchObject({ metrics: { mae: 2 }, pairedCount: 1 })
    expect(report.status).toBe('insufficient_evidence')
    expect(report.stageNightSummary).toMatchObject([{ totalNights: 1, scoredNights: 1, equalNightMeanAgreementDifference: 0 }])
    expect(report.nights[0].comparisons).toMatchObject([{ baseline: 'default', candidate: 'current', windows: [{ commonSupportScope: 'all_configurations', coverageReduced: false, differences: { commonAgreement: 0 } }] }])
  })
  it('rejects changed retained inputs and engine snapshots before evaluation', () => {
    const input = fixture()
    input.dataset.snapshot.sessions[0].vitals[0].heartRate = 100
    expect(() => evaluateBacktest(input)).toThrow('integrity mismatch')
    const wrongEngine = fixture()
    wrongEngine.job.configs[0].manifestHash = '0'.repeat(64)
    expect(() => evaluateBacktest(wrongEngine)).toThrow('engine/configuration mismatch')
  })
  it('honors fixed offsets for stage duration scoring without relabeling the original trace', () => {
    const input = fixture()
    input.job.protocol.clockOffsetMs = 60000
    input.job.protocolHash = configHash(input.job.protocol)
    const report = evaluateBacktest(input)
    expect(report.nights[0].evaluations[0].windows[0].stage?.pairedDurationMs).toBe(540000)
    expect(report.nights[0].comparisons[0].windows[0].commonSupport.baseline.pairedDurationMs).toBe(540000)
    expect(report.nights[0].comparisons[0].windows[0].commonSupport.candidate.pairedDurationMs).toBe(540000)
    expect(report.nights[0].evaluations[0].windows[0].blocks[0].start).toBe(start)
  })
  it('uses the frozen uncertainty policy while retaining insufficient-evidence status', () => {
    const input = fixture()
    const protocol = { ...input.job.protocol, nightUncertainty: { version: 'paired-night-percentile-v1' as const,
      seed: 'retained-policy', resamples: 200, minimumNights: 3 } }
    const report = evaluateBacktest({ ...input, job: { ...input.job, protocol, protocolHash: configHash(protocol) } })
    expect(report.stageNightSummary[0].uncertainty).toMatchObject({ policy: protocol.nightUncertainty,
      status: 'insufficient_nights', scoredNights: 1, interval: null })
    expect(report.status).toBe('insufficient_evidence')
  })
  it('applies the shared three-configuration support to every reported comparison', () => {
    const input = fixture()
    const candidate = { ...input.job.configs[0], label: 'candidate' as const }
    const report = evaluateBacktest({ ...input, job: { ...input.job, configs: [...input.job.configs, candidate] } })
    expect(report.nights[0].comparisons).toHaveLength(3)
    for (const comparison of report.nights[0].comparisons) {
      expect(comparison.windows[0]).toMatchObject({ commonSupportScope: 'all_configurations',
        commonSupport: { baseline: { pairedDurationMs: 600000 }, candidate: { pairedDurationMs: 600000 } } })
    }
  })
})
