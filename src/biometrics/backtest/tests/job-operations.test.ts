// @vitest-environment node
import { expect, it } from 'vitest'
import { createJobOperations } from '../job-operations'
const receipt = { allowed: true, sample: { qualificationId: 'qualified-build', checkedAtMs: 100000, ingestionAgeMs: 100 } }
it('retains bounded sampled ingestion evidence with monotonic duration and gaps', () => {
  let time = 0
  const operations = createJobOperations(() => time)
  operations.record(receipt)
  time = 7000
  operations.record({ ...receipt, sample: { ...receipt.sample, ingestionAgeMs: 300 } })
  time = 7200
  expect(operations.finish()).toMatchObject({ wallMs: 7200, ingestion: { checks: 2, samples: 2, allChecksMeasured: true,
    maximumObservedAgeMs: 300, maximumObservationGapMs: 7000, continuousMeasurement: false, qualificationId: 'qualified-build' } })
})
it('exposes missing, denied, and changing qualification evidence without inventing zero age', () => {
  const empty = createJobOperations(() => 0)
  empty.record(null)
  expect(empty.finish().ingestion).toMatchObject({ allChecksMeasured: false, samples: 0, maximumObservedAgeMs: null, qualificationId: null })
  for (const bad of [null, { ...receipt, allowed: false }, { ...receipt, sample: { ...receipt.sample, ingestionAgeMs: -1 } },
    { ...receipt, sample: { ...receipt.sample, qualificationId: 'different' } }]) {
    const operations = createJobOperations(() => 0)
    operations.record(receipt)
    operations.record(bad)
    expect(operations.finish().ingestion).toMatchObject({ allChecksMeasured: false, qualificationId: null })
  }
})
it('a single observation does not establish coverage over execution', () => {
  const operations = createJobOperations(() => 0)
  operations.record(receipt)
  expect(operations.finish().ingestion.allChecksMeasured).toBe(false)
})
