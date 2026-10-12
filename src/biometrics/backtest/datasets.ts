import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../algorithms/canonical'
import { normalizedMeasurementSchema } from '../references/contracts'
import { ReferenceStore } from '../references/store'
import { ReferenceInputError } from '../references/time'
import { assignWholeNightSplits } from './splits'
import { describeCoverage } from './coverage'

export const createDatasetSchema = z.object({
  side: z.enum(['left', 'right']), subjectId: z.string().min(1).max(200),
  sessionIds: z.array(z.number().int().positive()).min(1).max(60),
  referenceImportIds: z.array(z.string().uuid()).max(20),
  timezone: z.string().min(1).max(100),
  idempotencyKey: z.string().min(1).max(200),
}).strict()

const vitalSchema = z.object({ id: z.number().int(), timestampMs: z.number().int(), heartRate: z.number().nullable(),
  hrv: z.number().nullable(), breathingRate: z.number().nullable(), processingRunId: z.string().nullable() })
const movementSchema = z.object({ id: z.number().int(), timestampMs: z.number().int(), totalMovement: z.number() })
export const datasetSnapshotSchema = z.object({
  version: z.literal('processed-dataset-v1'), side: z.enum(['left', 'right']), subjectId: z.string(),
  sessions: z.array(z.object({ id: z.number().int(), startMs: z.number().int(), endMs: z.number().int(),
    sleepDurationSeconds: z.number(), timesExitedBed: z.number(), presentIntervals: z.unknown(), notPresentIntervals: z.unknown(),
    vitals: z.array(vitalSchema), movement: z.array(movementSchema),
  })),
  references: z.array(z.object({ importId: z.string(), revision: z.number(), contentHash: z.string(), source: z.string(),
    timePolicy: z.unknown(), measurements: z.array(normalizedMeasurementSchema) })),
  processingRuns: z.array(z.object({ id: z.string(), side: z.string(), kind: z.string(), bundle: z.unknown(),
    configHash: z.string(), calibrationHash: z.string().nullable(), inputIdentity: z.unknown(), startedAtMs: z.number(), endedAtMs: z.number().nullable() })),
})
export type DatasetSnapshot = z.infer<typeof datasetSnapshotSchema>

const LIMITS = { rows: 20000, datasetBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 }

/** Small retained processed snapshots. Waveform pinning is a separate capability. */
export class DatasetStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>, private readonly now = Date.now) {}

  create(raw: z.input<typeof createDatasetSchema>) {
    const input = createDatasetSchema.parse(raw)
    if (new Set(input.sessionIds).size !== input.sessionIds.length || new Set(input.referenceImportIds).size !== input.referenceImportIds.length) throw new ReferenceInputError('DUPLICATE_SELECTION', 'Select each session and import once')
    input.sessionIds.sort((a, b) => a - b)
    input.referenceImportIds.sort()
    const requestHash = configHash(input)
    const existing = this.db.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.idempotencyKey, input.idempotencyKey)).get()
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Dataset idempotency key was already used for a different selection')
      return this.describe(existing)
    }
    const captured = this.db.transaction(() => {
      const sessions = this.db.select().from(schema.sleepRecords).where(and(eq(schema.sleepRecords.side, input.side), inArray(schema.sleepRecords.id, input.sessionIds)))
        .orderBy(schema.sleepRecords.enteredBedAt, schema.sleepRecords.id).all()
      if (sessions.length !== input.sessionIds.length) throw new ReferenceInputError('NOT_FOUND', 'A selected session is missing or belongs to the other side')
      const splits = assignWholeNightSplits(sessions.map(row => ({ id: row.id, startMs: row.enteredBedAt.getTime(), endMs: row.leftBedAt.getTime() })), input.timezone)
      let remaining = LIMITS.rows
      const snapshotSessions = sessions.map((session) => {
        const vitals = this.db.select().from(schema.vitals).where(and(eq(schema.vitals.side, input.side),
          gte(schema.vitals.timestamp, session.enteredBedAt), lt(schema.vitals.timestamp, session.leftBedAt)))
          .orderBy(schema.vitals.timestamp).limit(remaining + 1).all()
        remaining -= vitals.length
        if (remaining < 0) throw new ReferenceInputError('RESOURCE_LIMIT', 'Select fewer sessions; processed snapshot row budget exceeded')
        const movement = this.db.select().from(schema.movement).where(and(eq(schema.movement.side, input.side),
          gte(schema.movement.timestamp, session.enteredBedAt), lt(schema.movement.timestamp, session.leftBedAt)))
          .orderBy(schema.movement.timestamp, schema.movement.id).limit(remaining + 1).all()
        remaining -= movement.length
        if (remaining < 0) throw new ReferenceInputError('RESOURCE_LIMIT', 'Select fewer sessions; processed snapshot row budget exceeded')
        return { id: session.id, startMs: session.enteredBedAt.getTime(), endMs: session.leftBedAt.getTime(),
          sleepDurationSeconds: session.sleepDurationSeconds, timesExitedBed: session.timesExitedBed,
          presentIntervals: session.presentIntervals, notPresentIntervals: session.notPresentIntervals,
          vitals: vitals.map(row => ({ id: row.id, timestampMs: row.timestamp.getTime(), heartRate: row.heartRate, hrv: row.hrv, breathingRate: row.breathingRate, processingRunId: row.processingRunId })),
          movement: movement.map(row => ({ id: row.id, timestampMs: row.timestamp.getTime(), totalMovement: row.totalMovement })),
        }
      })
      const store = new ReferenceStore(this.db)
      const families = new Set<string>()
      const references = input.referenceImportIds.map((importId) => {
        const descriptor = store.get(importId)
        if (descriptor.summary.side !== input.side || descriptor.summary.subjectId !== input.subjectId) throw new ReferenceInputError('SUBJECT_MISMATCH', 'All references must match the selected side and sleeper')
        if (families.has(descriptor.familyId)) throw new ReferenceInputError('REVISION_CONFLICT', 'Select only one revision from each reference family')
        families.add(descriptor.familyId)
        const measurements = []
        let cursor = 0
        do {
          const page = store.measurements(importId, cursor)
          remaining -= page.items.length
          if (remaining < 0) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reference selection exceeds snapshot row budget')
          measurements.push(...page.items.map(row => normalizedMeasurementSchema.parse(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id')))))
          if (page.nextCursor === null) break
          cursor = page.nextCursor
        } while (remaining >= 0)
        return { importId, revision: descriptor.revision, contentHash: descriptor.summary.contentHash,
          source: descriptor.summary.source, timePolicy: descriptor.summary.timePolicy, measurements }
      })
      const runIds = [...new Set(snapshotSessions.flatMap(session => session.vitals.flatMap(row => row.processingRunId ? [row.processingRunId] : [])))]
      const processingRuns: Array<typeof schema.biometricProcessingRuns.$inferSelect> = []
      for (let index = 0; index < runIds.length; index += 100) {
        processingRuns.push(...this.db.select().from(schema.biometricProcessingRuns)
          .where(and(eq(schema.biometricProcessingRuns.side, input.side), inArray(schema.biometricProcessingRuns.id, runIds.slice(index, index + 100)))).all())
      }
      processingRuns.sort((a, b) => a.id.localeCompare(b.id))
      return { snapshot: datasetSnapshotSchema.parse({ version: 'processed-dataset-v1', side: input.side, subjectId: input.subjectId,
        sessions: snapshotSessions, references, processingRuns }), splits }
    })
    // No write lock is held while computing hashes and coverage.
    const snapshotBytes = Buffer.byteLength(JSON.stringify(captured.snapshot))
    if (snapshotBytes > LIMITS.datasetBytes) throw new ReferenceInputError('RESOURCE_LIMIT', 'Processed dataset exceeds the 8 MiB snapshot limit')
    const manifest = { version: 'processed-dataset-manifest-v1', splitProtocol: captured.splits,
      coverage: captured.snapshot.sessions.map(session => ({ sessionId: session.id,
        vitals: describeCoverage(session.vitals.map(row => row.timestampMs), session.startMs, session.endMs, 60000),
        movement: describeCoverage(session.movement.map(row => row.timestampMs), session.startMs, session.endMs, 60000),
      })),
      capabilities: { comparison: true, stageReplay: captured.snapshot.sessions.some(session => session.vitals.length > 0), signalReplay: false },
      limitations: ['Raw channels, pump context and measured calibration bytes are not retained in this processed dataset; signal replay is unavailable.',
        'Historical stage replay must declare its calibration quality assumption when original calibration is unavailable.',
        'Reference deletion does not erase this separately retained dataset.',
        'Session side is known; historical occupant identity is asserted by the dataset creator, not measured by the pod.'],
    }
    const byteLength = snapshotBytes + Buffer.byteLength(JSON.stringify(manifest))
    if (byteLength > LIMITS.datasetBytes) throw new ReferenceInputError('RESOURCE_LIMIT', 'Dataset and manifest exceed the 8 MiB snapshot limit')
    const contentHash = configHash({ manifest, snapshot: captured.snapshot })
    return this.db.transaction((tx) => {
      const raced = tx.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.idempotencyKey, input.idempotencyKey)).get()
      if (raced) {
        if (raced.requestHash !== requestHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Dataset idempotency key changed')
        return this.describe(raced)
      }
      const total = tx.select({ bytes: sql<number>`coalesce(sum(${schema.biometricDatasets.byteLength}), 0)` }).from(schema.biometricDatasets).get()?.bytes ?? 0
      if (total + byteLength > LIMITS.totalBytes) throw new ReferenceInputError('RESOURCE_LIMIT', 'Processed datasets have reached their 64 MiB retained storage budget')
      const row = tx.insert(schema.biometricDatasets).values({ id: randomUUID(), side: input.side, subjectId: input.subjectId,
        idempotencyKey: input.idempotencyKey, requestHash, contentHash, manifest, snapshot: captured.snapshot, byteLength, createdAtMs: this.now() }).returning().get()
      return this.describe(row)
    }, { behavior: 'immediate' })
  }

  private describe(row: typeof schema.biometricDatasets.$inferSelect) {
    return { id: row.id, side: row.side, subjectId: row.subjectId, contentHash: row.contentHash,
      manifest: row.manifest, byteLength: row.byteLength, createdAtMs: row.createdAtMs }
  }

  read(id: string) {
    const row = this.db.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, id)).get()
    if (!row) throw new ReferenceInputError('NOT_FOUND', 'Dataset is unavailable')
    const snapshot = datasetSnapshotSchema.parse(row.snapshot)
    if (configHash({ manifest: row.manifest, snapshot }) !== row.contentHash) throw new ReferenceInputError('DATASET_CORRUPT', 'Retained dataset integrity check failed')
    return { ...this.describe(row), snapshot }
  }

  list(side: 'left' | 'right') {
    return this.db.select({ id: schema.biometricDatasets.id, side: schema.biometricDatasets.side,
      subjectId: schema.biometricDatasets.subjectId, contentHash: schema.biometricDatasets.contentHash,
      manifest: schema.biometricDatasets.manifest, byteLength: schema.biometricDatasets.byteLength, createdAtMs: schema.biometricDatasets.createdAtMs,
    }).from(schema.biometricDatasets).where(eq(schema.biometricDatasets.side, side))
      .orderBy(desc(schema.biometricDatasets.createdAtMs), desc(schema.biometricDatasets.id)).limit(100).all()
  }
}
