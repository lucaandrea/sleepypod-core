import { z } from 'zod'

export const sessionWindowSchema = z.object({
  id: z.number().int().positive(),
  startMs: z.number().int().min(1e12).max(4102444800000),
  endMs: z.number().int().min(1e12).max(4102444800000),
}).strict().refine(row => row.endMs > row.startMs && row.endMs - row.startMs <= 36 * 3600000,
  { message: 'Sessions must be positive and at most 36 hours long' })
export type SessionWindow = z.infer<typeof sessionWindowSchema>
export type EvaluationSplit = 'tuning' | 'validation' | 'holdout'

/**
 * Local-noon night grouping. Sessions touching the same night, or overlapping
 * sessions crossing noon, are one indivisible cohort. Snapshot the returned
 * assignment; never recalculate an existing dataset after timezone changes.
 */
export function assignWholeNightSplits(raw: SessionWindow[], timezone: string) {
  const sessions = z.array(sessionWindowSchema).min(1).max(60).parse(raw).sort((a, b) => a.startMs - b.startMs || a.id - b.id)
  if (new Set(sessions.map(row => row.id)).size !== sessions.length) throw new Error('Duplicate session selection')
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  const nightAt = (timestamp: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]))
    const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)))
    if (Number(parts.hour) < 12) day.setUTCDate(day.getUTCDate() - 1)
    return day.toISOString().slice(0, 10)
  }
  const labels = sessions.map((session) => {
    const keys = new Set([nightAt(session.startMs), nightAt(session.endMs - 1)])
    // Less than any local night length, including DST transitions. Endpoints
    // preserve short naps; intermediate samples cover sessions spanning noon.
    for (let time = session.startMs + 3600000; time < session.endMs; time += 3600000) keys.add(nightAt(time))
    return [...keys].sort()
  })
  const parent = sessions.map((_, i) => i)
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index]
    return index
  }
  const owner = new Map<string, number>()
  for (let index = 0; index < sessions.length; index++) {
    for (const label of labels[index]) {
      const previous = owner.get(label)
      if (previous !== undefined) parent[root(index)] = root(previous)
      else owner.set(label, index)
    }
  }
  const grouped = new Map<number, number[]>()
  for (let index = 0; index < sessions.length; index++) {
    const key = root(index)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)?.push(index)
  }
  const groups = [...grouped.values()].sort((a, b) => sessions[a[0]].startMs - sessions[b[0]].startMs)
  // This partition establishes independence, not statistical sufficiency.
  // With fewer than three cohorts, all work is descriptive tuning only.
  const hasThreeSplits = groups.length >= 3
  const tuningCount = hasThreeSplits ? Math.max(1, Math.min(groups.length - 2, Math.floor(groups.length * 0.6))) : groups.length
  const validationCount = hasThreeSplits ? Math.max(1, Math.floor(groups.length * 0.2)) : 0
  const assignments = groups.map((indices, index) => ({
    cohortId: labels[indices[0]][0],
    nightLabels: [...new Set(indices.flatMap(i => labels[i]))].sort(),
    sessionIds: indices.map(i => sessions[i].id),
    startMs: Math.min(...indices.map(i => sessions[i].startMs)),
    endMs: Math.max(...indices.map(i => sessions[i].endMs)),
    split: (index < tuningCount ? 'tuning' : index < tuningCount + validationCount ? 'validation' : 'holdout') as EvaluationSplit,
  }))
  return { version: 'chronological-whole-night-v1' as const, timezone,
    timezoneRuntime: { icu: typeof process !== 'undefined' ? process.versions?.icu ?? 'unknown' : 'unknown', tz: typeof process !== 'undefined' ? process.versions?.tz ?? 'unknown' : 'unknown' },
    grouping: 'local_noon_connected_sessions' as const, assignments,
    evidence: hasThreeSplits ? 'partitioned_not_validated' as const : 'descriptive_only' as const,
    limitations: ['Whole-night separation does not by itself establish sufficient reference support or improvement.',
      ...(hasThreeSplits ? [] : ['Fewer than three independent night cohorts; no validation or holdout claim is available.'])],
  }
}
