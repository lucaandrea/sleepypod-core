/**
 * Pairing and deviation statistics shared by the scorers. Deviation is always
 * pod − Watch, so a positive bias means the pod reads high.
 */

export type Pair = [pod: number, watch: number]
export type Sample = [timestampMs: number, value: number]

/** Pairing windows, by metric: how far a pod reading may sit from a Watch sample. */
export const WINDOWS = { hr: 60_000, br: 150_000, hrv: 300_000 } as const

export interface Point { t: number, v: number | null }

/** The pod value nearest in time to t, within tol ms; null when none. */
export function nearest(points: Point[], t: number, tol: number): number | null {
  let best: number | null = null
  let bestDt = Infinity
  for (const p of points) {
    const dt = Math.abs(p.t - t)
    if (p.v != null && dt <= tol && dt < bestDt) {
      best = p.v
      bestDt = dt
    }
  }
  return best
}

/** Mean of the pod values within tol ms of t; null when none. */
export function meanWithin(points: Point[], t: number, tol: number): number | null {
  const vs: number[] = []
  for (const p of points) {
    if (p.v != null && Math.abs(p.t - t) <= tol) vs.push(p.v)
  }
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null
}

/** Pair each Watch sample with a pod value picked by `pick`; unmatched samples are dropped. */
export function pairSamples(watch: Sample[], pick: (t: number) => number | null): Pair[] {
  const pairs: Pair[] = []
  for (const [t, w] of watch) {
    const p = pick(t)
    if (p != null) pairs.push([p, w])
  }
  return pairs
}

export interface Deviation { n: number, coverage: number, mae: number | null, bias: number | null, p90: number | null, corr: number | null }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** MAE, bias, 90th-percentile absolute error, Pearson r and coverage of the Watch samples. */
export function deviation(pairs: Pair[], watchCount: number): Deviation {
  if (pairs.length === 0) return { n: 0, coverage: 0, mae: null, bias: null, p90: null, corr: null }
  const d = pairs.map(([p, w]) => p - w)
  const abs = d.map(Math.abs).sort((a, b) => a - b)
  const mp = mean(pairs.map(([p]) => p))
  const mw = mean(pairs.map(([, w]) => w))
  const sp = Math.sqrt(mean(pairs.map(([p]) => (p - mp) ** 2)))
  const sw = Math.sqrt(mean(pairs.map(([, w]) => (w - mw) ** 2)))
  const cov = mean(pairs.map(([p, w]) => (p - mp) * (w - mw)))
  return {
    n: pairs.length,
    coverage: watchCount ? pairs.length / watchCount : 0,
    mae: mean(abs),
    bias: mean(d),
    p90: abs[Math.floor(abs.length * 0.9)],
    corr: sp && sw ? cov / (sp * sw) : null,
  }
}

export const fmt = (x: number | null | undefined, digits = 1) => x == null ? '–' : x.toFixed(digits)
