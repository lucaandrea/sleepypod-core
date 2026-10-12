export interface SupportInterval { start: number, end: number }

function ordered<T extends SupportInterval>(intervals: T[]) {
  if (intervals.length > 100000) throw new Error('Too many support intervals')
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  if (sorted.some((row, index) => !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.end <= row.start
    || (index > 0 && sorted[index - 1].end > row.start))) throw new Error('Support intervals must be valid and nonoverlapping')
  return sorted
}

/** Linear sweep after validation/sorting; preserve labels from the left input. */
export function restrictToSupport<T extends SupportInterval>(input: T[], support: SupportInterval[]): T[] {
  const left = ordered(input), right = ordered(support)
  const result: T[] = []
  let i = 0, j = 0
  while (i < left.length && j < right.length) {
    const a = left[i], b = right[j]
    const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end)
    if (end > start) result.push({ ...a, start, end })
    if (a.end <= b.end) i++
    else j++
  }
  return result
}

/** One common denominator across every submitted configuration. An absent
 * output empties the intersection; it never silently drops out of the set. */
export function intersectOutputSupport(outputs: SupportInterval[][], start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > 86400000
    || outputs.length < 1 || outputs.length > 3) throw new Error('Invalid bounded common-support input')
  let support: SupportInterval[] = [{ start, end }]
  for (const output of outputs) support = restrictToSupport(support, output)
  return support
}
