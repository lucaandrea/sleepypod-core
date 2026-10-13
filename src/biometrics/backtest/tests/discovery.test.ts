// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { listReplaySessions, sessionCapabilities } from '../discovery'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
const start = 1791673200000
function session(id = 1, hours = 1, side: 'left' | 'right' = 'left') {
  db.insert(schema.sleepRecords).values({ id, side, enteredBedAt: new Date(start), leftBedAt: new Date(start + hours * 3600000), sleepDurationSeconds: Math.max(0, hours * 3600), timesExitedBed: 0 }).run()
}
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
})
afterEach(() => sqlite.close())
it('pages equal start times without duplicates and keeps sides separate', () => {
  for (let id = 1; id <= 22; id++) session(id)
  session(23, 1, 'right')
  const first = listReplaySessions(db, 'left')
  expect(first.items.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => 22 - i))
  expect(first.nextCursor).toEqual({ startMs: start, id: 3 })
  if (!first.nextCursor) throw new Error('Expected another page')
  const next = listReplaySessions(db, 'left', first.nextCursor)
  expect(next.items.map(row => row.id)).toEqual([2, 1])
  expect(next.nextCursor).toBeNull()
  expect(listReplaySessions(db, 'right').items.map(row => row.id)).toEqual([23])
})
it('reports an empty session without implying retained waveforms or stage support', () => {
  session()
  expect(sessionCapabilities(db, 'left', 1)).toMatchObject({ comparison: false, stageReplay: false, signalReplay: false,
    processed: { legacyUnknownProvenanceCount: 0, vitals: { count: 0 }, movement: { count: 0 } }, referenceMetrics: [],
    limitations: expect.arrayContaining(['No stored vitals are available for comparison or stage replay.']) })
  expect(() => sessionCapabilities(db, 'right', 1)).toThrow('not found for this side')
})
it.each([0, -1, 37])('rejects invalid or over-budget session duration %s hours', (hours) => {
  session(1, hours)
  expect(() => sessionCapabilities(db, 'left', 1)).toThrow('boundaries exceed')
})
it.each([24, 25])('distinguishes comparison from the one-day stage replay limit at %s hours', (hours) => {
  session(1, hours)
  db.insert(schema.biometricProcessingRuns).values({ id: 'known', side: 'left', kind: 'live', bundle: {}, configHash: 'fixture', inputIdentity: {}, startedAtMs: start }).run()
  db.insert(schema.vitals).values([
    { side: 'left', timestamp: new Date(start), heartRate: 60, processingRunId: 'known' },
    { side: 'left', timestamp: new Date(start + 60000), heartRate: 61 },
    { side: 'right', timestamp: new Date(start), heartRate: 70 },
    { side: 'left', timestamp: new Date(start + hours * 3600000), heartRate: 80 },
  ]).run()
  const result = sessionCapabilities(db, 'left', 1)
  expect(result).toMatchObject({ comparison: true, stageReplay: hours === 24, processed: { legacyUnknownProvenanceCount: 1, vitals: { count: 2 } } })
  expect(result.limitations.includes('Stage replay currently requires a merged window of at most one day.')).toBe(hours > 24)
})
it('bounds aggregate processed rows before returning an incomplete inventory', () => {
  session(1, 6)
  sqlite.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n < 20001)
    INSERT INTO vitals(side,timestamp,heart_rate) SELECT 'left', ${start / 1000} + n, 60 FROM rows`)
  expect(() => sessionCapabilities(db, 'left', 1)).toThrow('processed-data row budget')
})
