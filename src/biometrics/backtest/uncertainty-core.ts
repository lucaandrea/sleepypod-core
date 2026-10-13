import { nightBootstrapSchema, type NightBootstrapPolicy } from './uncertainty-policy'
export type { NightBootstrapPolicy } from './uncertainty-policy'

/** Versioned, platform-independent SHA-256 counter stream. Rejection sampling
 * avoids modulo bias. This seed is for reproducibility, not security. */
function indexStream(seed: string, size: number, digest: (text: string) => Uint8Array) {
  let counter = 0, position = 32, bytes: Uint8Array = new Uint8Array(32)
  const ceiling = 4294967296 - (4294967296 % size)
  return () => {
    for (;;) {
      if (position === 32) {
        bytes = digest(JSON.stringify(['paired-night-percentile-v1', seed, counter++]))
        position = 0
      }
      const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(position, false)
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
export function createNightUncertainty(digest: (text: string) => Uint8Array, statistic: 'equal_night_mean_common_agreement_difference' | 'equal_night_mean_common_mae_difference' = 'equal_night_mean_common_agreement_difference') {
  return function nightUncertainty(input: Array<{ cohortId: string, difference: number | null }>, rawPolicy?: NightBootstrapPolicy) {
    if (input.length > 60 || new Set(input.map(row => row.cohortId)).size !== input.length
      || input.some(row => row.difference !== null && (!Number.isFinite(row.difference) || Math.abs(row.difference) > (statistic === 'equal_night_mean_common_agreement_difference' ? 1 : 2 * Number.MAX_SAFE_INTEGER)))) throw new Error('Invalid paired-night uncertainty input')
    const policy = rawPolicy === undefined ? null : nightBootstrapSchema.parse(rawPolicy)
    const ordered = [...input].sort((a, b) => a.cohortId < b.cohortId ? -1 : a.cohortId > b.cohortId ? 1 : 0)
    const values = ordered.flatMap(row => row.difference === null ? [] : [row.difference])
    const metadata = { policy, confidenceLevel: 0.95, samplingUnit: 'whole_night_cohort' as const,
      statistic, scoredNights: values.length, omittedNights: input.length - values.length,
      estimate: values.length ? average(values) : null,
      limitations: ['Exploratory interval assumes exchangeable nights; serial dependence may understate uncertainty.',
        'The requested minimum night count is a reporting threshold, not proof of sufficient evidence.',
        'Missing-reference nights are omitted and remain counted; the interval does not establish whole-history accuracy.',
        'This interval is not a promotion decision or clinical validation.'] }
    if (!policy) return { ...metadata, status: 'not_requested' as const, interval: null }
    if (values.length < policy.minimumNights) return { ...metadata, status: 'insufficient_nights' as const, interval: null }
    if (values.every(value => value === values[0])) return { ...metadata, status: 'degenerate' as const, interval: null }
    const index = indexStream(policy.seed, values.length, digest)
    const samples: number[] = []
    for (let replicate = 0; replicate < policy.resamples; replicate++) {
      let sum = 0
      for (let draw = 0; draw < values.length; draw++) sum += values[index()]
      samples.push(sum / values.length)
    }
    samples.sort((a, b) => a - b)
    return { ...metadata, status: 'estimated' as const, interval: { lower: quantile(samples, 0.025), upper: quantile(samples, 0.975) } }
  }
}
