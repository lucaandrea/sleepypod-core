import { and, desc, eq, gt, gte, lt, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { coverageSchema } from './contracts'
import { describeCoverage } from './coverage'

const side = z.enum(['left', 'right'])
const sessionSchema = z.object({ id: z.number(), side, startMs: z.number(), endMs: z.number(), sleepDurationSeconds: z.number(), timesExitedBed: z.number() })
export const sessionPageSchema = z.object({ items: z.array(sessionSchema), nextCursor: z.object({ startMs: z.number(), id: z.number() }).nullable() })
export const sessionCapabilitiesSchema = z.object({
  session: sessionSchema,
  processed: z.object({ vitals: coverageSchema, movement: coverageSchema, legacyUnknownProvenanceCount: z.number() }),
  referenceMetrics: z.array(z.object({ metric: z.string(), count: z.number() })),
  comparison: z.boolean(), stageReplay: z.boolean(), signalReplay: z.literal(false), rawWaveforms: z.literal('not_inventoried'),
  limitations: z.array(z.string()),
})
const describeSession = (row: typeof schema.sleepRecords.$inferSelect) => ({ id: row.id, side: row.side, startMs: row.enteredBedAt.getTime(),
  endMs: row.leftBedAt.getTime(), sleepDurationSeconds: row.sleepDurationSeconds, timesExitedBed: row.timesExitedBed })

export function listReplaySessions(db: BetterSQLite3Database<typeof schema>, selectedSide: 'left' | 'right', cursor?: { startMs: number, id: number }) {
  const records = db.select().from(schema.sleepRecords).where(and(eq(schema.sleepRecords.side, selectedSide), cursor
    ? or(lt(schema.sleepRecords.enteredBedAt, new Date(cursor.startMs)), and(eq(schema.sleepRecords.enteredBedAt, new Date(cursor.startMs)), lt(schema.sleepRecords.id, cursor.id)))
    : undefined))
    .orderBy(desc(schema.sleepRecords.enteredBedAt), desc(schema.sleepRecords.id)).limit(21).all()
  const items = records.slice(0, 20).map(describeSession)
  const last = items.at(-1)
  return { items, nextCursor: records.length > 20 && last ? { startMs: last.startMs, id: last.id } : null }
}

export function sessionCapabilities(db: BetterSQLite3Database<typeof schema>, selectedSide: 'left' | 'right', sessionId: number) {
  return db.transaction(() => {
    const record = db.select().from(schema.sleepRecords).where(and(eq(schema.sleepRecords.side, selectedSide), eq(schema.sleepRecords.id, sessionId))).get()
    if (!record) throw new ReferenceInputError('NOT_FOUND', 'Session not found for this side')
    const session = describeSession(record)
    if (session.endMs <= session.startMs || session.endMs - session.startMs > 36 * 3600000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Session boundaries exceed the inspection budget')
    const vitals = db.select({ timestamp: schema.vitals.timestamp, run: schema.vitals.processingRunId }).from(schema.vitals).where(and(eq(schema.vitals.side, selectedSide),
      gte(schema.vitals.timestamp, record.enteredBedAt), lt(schema.vitals.timestamp, record.leftBedAt))).orderBy(schema.vitals.timestamp).limit(20001).all()
    const movement = db.select({ timestamp: schema.movement.timestamp }).from(schema.movement).where(and(eq(schema.movement.side, selectedSide),
      gte(schema.movement.timestamp, record.enteredBedAt), lt(schema.movement.timestamp, record.leftBedAt))).orderBy(schema.movement.timestamp).limit(20001).all()
    if (vitals.length + movement.length > 20000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Session exceeds the retained processed-data row budget')
    const referenceMetrics = db.select({ metric: schema.referenceMeasurements.metric, count: sql<number>`count(*)` }).from(schema.referenceMeasurements)
      .where(and(eq(schema.referenceMeasurements.side, selectedSide), lt(schema.referenceMeasurements.startMs, session.endMs),
        or(gt(schema.referenceMeasurements.endMs, session.startMs), and(eq(schema.referenceMeasurements.temporalKind, 'point'), gte(schema.referenceMeasurements.startMs, session.startMs)))))
      .groupBy(schema.referenceMeasurements.metric).all()
    return { session,
      processed: { vitals: describeCoverage(vitals.map(row => row.timestamp.getTime()), session.startMs, session.endMs, 60000),
        movement: describeCoverage(movement.map(row => row.timestamp.getTime()), session.startMs, session.endMs, 60000),
        legacyUnknownProvenanceCount: vitals.filter(row => row.run === null).length },
      referenceMetrics, comparison: vitals.length > 0, stageReplay: vitals.length > 0 && session.endMs - session.startMs <= 86400000,
      signalReplay: false as const, rawWaveforms: 'not_inventoried' as const,
      limitations: ['Reference counts include available revisions; select one revision per source family when freezing inputs.',
        'Raw archives and pump/occupancy context have not been retained by this processed-data service.',
        'Movement and vitals availability use nominal one-minute cadence, not inferred continuous signal support.',
        ...(session.endMs - session.startMs > 86400000 ? ['Stage replay currently requires a merged window of at most one day.'] : []),
        ...(!vitals.length ? ['No stored vitals are available for comparison or stage replay.'] : [])],
    }
  })
}
