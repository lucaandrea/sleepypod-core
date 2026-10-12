import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { configHash, dataHash } from '../algorithms/canonical'
import { normalizedMeasurementSchema } from '../references/contracts'
import { ReferenceStore } from '../references/store'
import { ReferenceInputError } from '../references/time'
import { assignWholeNightSplits } from './splits'
import { describeCoverage } from './coverage'

import { createDatasetSchema } from './contracts'
export { createDatasetSchema } from './contracts'

export { datasetSnapshotSchema } from './contracts'
import { datasetSnapshotSchema } from './contracts'

const LIMITS = { rows: 20000, datasetBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 }

/** Creates processed snapshots; reads and releases both retained dataset formats. */
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
    const contentHash = dataHash({ manifest, snapshot: captured.snapshot })
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
      manifest: row.manifest, byteLength: row.byteLength, createdAtMs: row.createdAtMs, releasedAtMs: row.releasedAtMs, available: row.releasedAtMs === null }
  }

  read(id: string) {
    const row = this.db.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, id)).get()
    if (!row) throw new ReferenceInputError('NOT_FOUND', 'Dataset is unavailable')
    if (row.releasedAtMs !== null) throw new ReferenceInputError('DATASET_RELEASED', 'Retained dataset inputs were explicitly released')
    const snapshot = datasetSnapshotSchema.parse(row.snapshot)
    if (dataHash({ manifest: row.manifest, snapshot }) !== row.contentHash) throw new ReferenceInputError('DATASET_CORRUPT', 'Retained dataset integrity check failed')
    return { ...this.describe(row), snapshot }
  }

  release(id: string) {
    return this.db.transaction((tx) => {
      const dataset = tx.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, id)).get()
      if (!dataset) throw new ReferenceInputError('NOT_FOUND', 'Dataset not found')
      if (dataset.releasedAtMs !== null) return this.describe(dataset)
      const active = tx.select({ id: schema.biometricBacktestJobs.id }).from(schema.biometricBacktestJobs)
        .innerJoin(schema.biometricExperiments, eq(schema.biometricBacktestJobs.experimentId, schema.biometricExperiments.id))
        .where(and(eq(schema.biometricExperiments.datasetId, id), inArray(schema.biometricBacktestJobs.state, ['queued', 'running', 'cancel_requested', 'interrupted']))).get()
      if (active) throw new ReferenceInputError('REVISION_CONFLICT', 'Cancel or finish jobs using this dataset before releasing its inputs')
      const releasedAtMs = this.now()
      const references = schema.biometricDatasetRawArtifacts
      const artifacts = schema.biometricRawArtifacts
      tx.update(references).set({ releasedAtMs })
        .where(and(eq(references.datasetId, id), isNull(references.releasedAtMs))).run()
      // Mark storage eligible for collection only after its last live reference
      // is released. The file collector separately serializes with publication.
      tx.update(artifacts).set({ releasedAtMs }).where(and(isNull(artifacts.releasedAtMs),
        inArray(artifacts.contentHash, tx.select({ hash: references.artifactHash }).from(references).where(eq(references.datasetId, id))),
        sql`NOT EXISTS (SELECT 1 FROM biometric_dataset_raw_artifacts AS live
          WHERE live.artifact_hash = ${artifacts.contentHash} AND live.released_at_ms IS NULL)`,
      )).run()
      const tombstone = { released: true }
      const byteLength = Buffer.byteLength(JSON.stringify(dataset.manifest)) + Buffer.byteLength(JSON.stringify(tombstone))
      const released = tx.update(schema.biometricDatasets).set({ snapshot: tombstone, byteLength, releasedAtMs })
        .where(eq(schema.biometricDatasets.id, id)).returning().get()
      return this.describe(released)
    }, { behavior: 'immediate' })
  }

  descriptor(id: string) {
    const row = this.db.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, id)).get()
    if (!row) throw new ReferenceInputError('NOT_FOUND', 'Dataset not found')
    if (row.releasedAtMs === null) {
      const snapshot = datasetSnapshotSchema.parse(row.snapshot)
      if (dataHash({ manifest: row.manifest, snapshot }) !== row.contentHash) throw new ReferenceInputError('DATASET_CORRUPT', 'Retained dataset integrity check failed')
    }
    return this.describe(row)
  }

  page(side: 'left' | 'right', cursor?: { createdAtMs: number, id: string }) {
    const rows = this.db.select({ id: schema.biometricDatasets.id, side: schema.biometricDatasets.side,
      subjectId: schema.biometricDatasets.subjectId, contentHash: schema.biometricDatasets.contentHash,
      manifest: schema.biometricDatasets.manifest, byteLength: schema.biometricDatasets.byteLength, createdAtMs: schema.biometricDatasets.createdAtMs, releasedAtMs: schema.biometricDatasets.releasedAtMs,
    }).from(schema.biometricDatasets).where(and(eq(schema.biometricDatasets.side, side), cursor
      ? or(lt(schema.biometricDatasets.createdAtMs, cursor.createdAtMs), and(eq(schema.biometricDatasets.createdAtMs, cursor.createdAtMs), lt(schema.biometricDatasets.id, cursor.id)))
      : undefined))
      .orderBy(desc(schema.biometricDatasets.createdAtMs), desc(schema.biometricDatasets.id)).limit(51).all()
    const items = rows.slice(0, 50).map(row => ({ ...row, available: row.releasedAtMs === null }))
    const last = items.at(-1)
    return { items, nextCursor: rows.length > 50 && last ? { createdAtMs: last.createdAtMs, id: last.id } : null }
  }

  list(side: 'left' | 'right') {
    return this.db.select({ id: schema.biometricDatasets.id, side: schema.biometricDatasets.side,
      subjectId: schema.biometricDatasets.subjectId, contentHash: schema.biometricDatasets.contentHash,
      manifest: schema.biometricDatasets.manifest, byteLength: schema.biometricDatasets.byteLength, createdAtMs: schema.biometricDatasets.createdAtMs, releasedAtMs: schema.biometricDatasets.releasedAtMs,
    }).from(schema.biometricDatasets).where(eq(schema.biometricDatasets.side, side))
      .orderBy(desc(schema.biometricDatasets.createdAtMs), desc(schema.biometricDatasets.id)).limit(100).all()
  }
}
