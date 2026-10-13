import { fixtureResourceTestPolicy } from './resource-test-policy'
import { describe, expect, it } from 'vitest'
import { assessPackageResources } from './resource-assessment'
import { ResourceObservations } from './resources'
function fixture() {
  const observations = new ResourceObservations(0)
  observations.record({ sourceTimestampMs: 1000, cpuMs: 10, memoryBytes: 1000000, processes: 1 }, 100)
  return { measurements: observations.snapshot(200), limits: { cpuMs: 1000, wallMs: 1000, memoryBytes: 2000000, processes: 1, outputBytes: 10000 }, wallMs: 200 }
}
describe('package fixture resource assessment', () => {
  it('binds explicit policy and accepts complete measurements within enforced limits', () => {
    const result = assessPackageResources(fixture(), fixtureResourceTestPolicy)
    expect(result.status).toBe('within_observed_limits')
    expect(assessPackageResources(fixture(), { ...fixtureResourceTestPolicy, maximumCpuMs: 6000 }).policyHash).not.toBe(result.policyHash)
  })
  it('does not turn missing, stale or inconsistent evidence into passing evidence', () => {
    const input = fixture()
    for (const measurements of [null, { ...input.measurements, attempts: 2, allAttemptsMeasured: false },
      { ...input.measurements, samples: 2 }, { ...input.measurements, source: 'candidate_claim' }]) {
      expect(assessPackageResources({ ...input, measurements }, fixtureResourceTestPolicy).status).toBe('insufficient_evidence')
    }
    expect(assessPackageResources(input, { ...fixtureResourceTestPolicy, minimumSamples: 2 }).status).toBe('insufficient_evidence')
    expect(assessPackageResources(input, { ...fixtureResourceTestPolicy, maximumObservationGapMs: 50 }).status).toBe('insufficient_evidence')
  })
  it('fails measured overruns and limits broader than the reviewed policy', () => {
    const input = fixture()
    for (const changed of [{ ...input, wallMs: 6000 }, { ...input, measurements: { ...input.measurements, maximumObservedCpuMs: 6000 } },
      { ...input, measurements: { ...input.measurements, peakObservedMemoryBytes: 100000000 } },
      { ...input, measurements: { ...input.measurements, maximumObservedProcesses: 2 } },
      { ...input, limits: { ...input.limits, memoryBytes: 100000000 } }]) {
      expect(assessPackageResources(changed, fixtureResourceTestPolicy).status).toBe('failed')
    }
  })
  it('retains a known budget failure even if observation coverage is incomplete', () => {
    const input = fixture()
    const result = assessPackageResources({ ...input, wallMs: 6000, measurements: { ...input.measurements, attempts: 2, allAttemptsMeasured: false } }, fixtureResourceTestPolicy)
    expect(result).toMatchObject({ status: 'failed', failures: ['wall_budget_exceeded'], missing: ['unmeasured_attempts'] })
  })
})
