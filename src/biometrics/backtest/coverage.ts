/** No interpolation: expose actual timestamps and gaps under an explicit cadence. */
export function describeCoverage(timestamps: number[], startMs: number, endMs: number, expectedCadenceMs: number) {
  if (![startMs, endMs, expectedCadenceMs].every(Number.isSafeInteger) || endMs <= startMs || expectedCadenceMs <= 0
    || timestamps.length > 100000 || timestamps.some(time => !Number.isSafeInteger(time))) throw new Error('Invalid bounded coverage input')
  const times = [...new Set(timestamps.filter(time => time >= startMs && time < endMs))].sort((a, b) => a - b)
  const gaps: Array<{ startMs: number, endMs: number }> = []
  let cursor = startMs
  for (const time of times) {
    if (time > cursor) gaps.push({ startMs: cursor, endMs: time })
    cursor = Math.min(endMs, time + expectedCadenceMs)
  }
  if (cursor < endMs) gaps.push({ startMs: cursor, endMs })
  return { count: times.length, duplicateTimestamps: timestamps.filter(time => time >= startMs && time < endMs).length - times.length,
    firstMs: times[0] ?? null, lastMs: times.at(-1) ?? null,
    expectedCadenceMs, gaps, gapDurationMs: gaps.reduce((sum, gap) => sum + gap.endMs - gap.startMs, 0),
    // Cadence-based availability is not sensor support duration.
    interpretation: 'cadence_availability_not_measured_support' as const }
}
