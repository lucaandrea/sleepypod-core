import { describe, expect, it } from 'vitest'
import { assignWholeNightSplits } from '../splits'
import { describeCoverage } from '../coverage'
const session = (id: number, start: string, end: string) => ({ id, startMs: Date.parse(start), endMs: Date.parse(end) })

describe('frozen whole-night split assignment', () => {
  it('keeps naps and overnight sessions in the same local-noon cohort across DST', () => {
    const result = assignWholeNightSplits([
      session(1, '2026-11-01T00:00:00-07:00', '2026-11-01T07:00:00-08:00'),
      session(2, '2026-10-31T14:00:00-07:00', '2026-10-31T15:00:00-07:00'),
      session(3, '2026-11-02T00:00:00-08:00', '2026-11-02T08:00:00-08:00'),
      session(4, '2026-11-03T00:00:00-08:00', '2026-11-03T08:00:00-08:00'),
    ], 'America/Los_Angeles')
    expect(result.assignments.map(group => [group.split, group.sessionIds])).toEqual([
      ['tuning', [2, 1]], ['validation', [3]], ['holdout', [4]],
    ])
    expect(result.assignments[0].nightLabels).toEqual(['2026-10-31'])
    expect(result.evidence).toBe('partitioned_not_validated')
  })
  it('joins sessions bridging adjacent nights instead of leaking correlated data', () => {
    const result = assignWholeNightSplits([
      session(1, '2026-10-01T23:00:00Z', '2026-10-02T13:00:00Z'),
      session(2, '2026-10-02T12:00:00Z', '2026-10-02T15:00:00Z'),
      session(3, '2026-10-02T23:00:00Z', '2026-10-03T08:00:00Z'),
    ], 'UTC')
    expect(result.assignments).toHaveLength(1)
    expect(result.assignments[0].sessionIds).toEqual([1, 2, 3])
    expect(result.evidence).toBe('descriptive_only')
  })
  it('uses all small datasets descriptively and rejects malformed or duplicate sessions', () => {
    const rows = [session(1, '2026-10-01T23:00:00Z', '2026-10-02T08:00:00Z')]
    expect(assignWholeNightSplits(rows, 'UTC').assignments[0].split).toBe('tuning')
    expect(() => assignWholeNightSplits([...rows, ...rows], 'UTC')).toThrow('Duplicate')
    expect(() => assignWholeNightSplits(rows, 'not-a-timezone')).toThrow()
    expect(() => assignWholeNightSplits([{ ...rows[0], endMs: rows[0].startMs }], 'UTC')).toThrow()
  })
})

describe('coverage gaps', () => {
  it('reports leading, internal and trailing gaps without substituting zeros', () => {
    expect(describeCoverage([100, 100, 200, 700], 0, 1000, 100)).toMatchObject({ count: 3, duplicateTimestamps: 1,
      firstMs: 100, lastMs: 700, gapDurationMs: 700, gaps: [{ startMs: 0, endMs: 100 }, { startMs: 300, endMs: 700 }, { startMs: 800, endMs: 1000 }] })
    expect(describeCoverage([], 0, 1000, 100)).toMatchObject({ firstMs: null, lastMs: null, gapDurationMs: 1000 })
  })
})
