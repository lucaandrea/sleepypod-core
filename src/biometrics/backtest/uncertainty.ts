import { createHash } from 'node:crypto'
import { nightBootstrapSchema, type NightBootstrapPolicy } from './uncertainty-policy'
export type { NightBootstrapPolicy } from './uncertainty-policy'

/** Versioned, platform-independent SHA-256 counter stream. Rejection sampling
 * avoids modulo bias. This seed is for reproducibility, not security. */
function indexStream(seed: string, size: number) {
  let counter = 0, position = 32, bytes = Buffer.alloc(32)
  const ceiling = 4294967296 - (4294967296 % size)
  return () => {
    for (;;) {
      if (position === 32) {
        bytes = createHash('sha256').update(JSON.stringify(['paired-night-percentile-v1', seed, counter++])).digest()
        position = 0
      }
      const value = bytes.readUInt32BE(position)
      position += 4
      if (value < ceiling) return value % size
    }
  }
}
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
function quantile(sorted: number[], probability: number) {
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position), fraction = position - lower
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower])
}

/** Resample paired whole-night differences, never correlated epochs. An
 * exploratory interval alone cannot award improvement or validate activation. */
export function nightUncertainty(input: Array<{ cohortId: string, difference: number | null }>, rawPolicy?: NightBootstrapPolicy) {
  if (input.length > 60 || new Set(input.map(row => row.cohortId)).size !== input.length
    || input.some(row => row.difference !== null && (!Number.isFinite(row.difference) || Math.abs(row.difference) > 1))) throw new Error('Invalid paired-night uncertainty input')
  const policy = rawPolicy === undefined ? null : nightBootstrapSchema.parse(rawPolicy)
  const ordered = [...input].sort((a, b) => a.cohortId < b.cohortId ? -1 : a.cohortId > b.cohortId ? 1 : 0)
  const values = ordered.flatMap(row => row.difference === null ? [] : [row.difference])
  const metadata = { policy, confidenceLevel: 0.95, samplingUnit: 'whole_night_cohort' as const,
    statistic: 'equal_night_mean_common_agreement_difference' as const, scoredNights: values.length, omittedNights: input.length - values.length,
    estimate: values.length ? average(values) : null,
    limitations: ['Exploratory interval assumes exchangeable nights; serial dependence may understate uncertainty.',
      'The requested minimum night count is a reporting threshold, not proof of sufficient evidence.',
      'Missing-reference nights are omitted and remain counted; the interval does not establish whole-history accuracy.',
      'This interval is not a promotion decision or clinical validation.'] }
  if (!policy) return { ...metadata, status: 'not_requested' as const, interval: null }
  if (values.length < policy.minimumNights) return { ...metadata, status: 'insufficient_nights' as const, interval: null }
  if (values.every(value => value === values[0])) return { ...metadata, status: 'degenerate' as const, interval: null }
  const index = indexStream(policy.seed, values.length)
  const samples: number[] = []
  for (let replicate = 0; replicate < policy.resamples; replicate++) {
    let sum = 0
    for (let draw = 0; draw < values.length; draw++) sum += values[index()]
    samples.push(sum / values.length)
  }
  samples.sort((a, b) => a - b)
  return { ...metadata, status: 'estimated' as const, interval: { lower: quantile(samples, 0.025), upper: quantile(samples, 0.975) } }
}
