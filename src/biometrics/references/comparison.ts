import { and, eq, gte, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
import { sideSchema } from '@/src/server/validation-schemas'
import { timestampMsSchema } from './contracts'
import { alignReferences, DEFAULT_ALIGNMENT } from './alignment'
import { ReferenceStore } from './store'
import { ReferenceInputError } from './time'

export const compareReadingsSchema = z.object({
  side: sideSchema,
  subjectId: z.string().min(1).max(200),
  importId: z.string().uuid(),
  metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1', 'hrv_rmssd', 'hrv_sdnn', 'hrv_unknown']),
  startMs: timestampMsSchema,
  endMs: timestampMsSchema,
  pointToleranceMs: z.number().int().min(0).max(300000).default(30000),
  clockOffsetMs: z.number().int().min(-3600000).max(3600000).default(0),
}).strict().refine(input => input.endMs > input.startMs && input.endMs - input.startMs <= 86400000, {
  message: 'Select an interval greater than zero and at most 24 hours',
})

const numericScores = z.object({ mae: z.number(), medianAbsoluteError: z.number(), p95AbsoluteError: z.number(), signedBias: z.number() })
export const comparisonReportSchema = z.object({
  version: z.literal('stored-readings-comparison-v1'),
  inputHash: z.string(),
  side: sideSchema, subjectId: z.string(), startMs: z.number(), endMs: z.number(),
  importId: z.string().uuid(), importRevision: z.number(), source: z.string(),
  status: z.enum(['no_reference', 'compared', 'no_overlap', 'incompatible']),
  requestedMetric: z.string(), metric: z.string(), windowMs: z.number().nullable(),
  policy: z.object({ version: z.literal('reference-alignment-v1'), pointToleranceMs: z.number(), clockOffsetMs: z.number(), offsetSource: z.literal('fixed') }),
  metrics: numericScores.nullable(), pairedCount: z.number(), pairedDurationMs: z.number(),
  eligibleReferences: z.number(), duplicateReferences: z.number(), excludedReferences: z.number(),
  referenceCoverage: z.number().nullable(), outputCoverage: z.number().nullable(),
  observationCount: z.number(), validObservationCount: z.number(), matchedObservationCount: z.number(),
  unmatchedReferences: z.number(), unmatchedObservations: z.number(), exclusions: z.record(z.string(), z.number()),
  provenance: z.array(z.object({ processingRunId: z.string().nullable(), count: z.number() })),
  limitations: z.array(z.string()),
})

/** Bounded, read-only comparison. Saved evaluations instead retain their input bytes. */
export function compareStoredReadings(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof compareReadingsSchema>) {
  const input = compareReadingsSchema.parse(raw)
  const store = new ReferenceStore(db)
  // Capture all input rows in a single read snapshot, then release SQLite before scoring.
  const snapshot = db.transaction(() => {
    const reference = store.get(input.importId)
    if (!reference.available) throw new ReferenceInputError('REFERENCE_DELETED', 'Reference measurements were explicitly deleted')
    if (reference.summary.side !== input.side || reference.summary.subjectId !== input.subjectId) throw new ReferenceInputError('SUBJECT_MISMATCH', 'Select the import matching this side and sleeper')
    const measurements = []
    let cursor = 0
    do {
      const page = store.measurements(input.importId, cursor)
      measurements.push(...page.items)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    } while (measurements.length <= 2000)
    if (measurements.length > 2000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reference import exceeds comparison budget')
    const rows = db.select().from(schema.vitals).where(and(eq(schema.vitals.side, input.side),
      gte(schema.vitals.timestamp, new Date(Math.ceil(input.startMs / 1000) * 1000)),
      lt(schema.vitals.timestamp, new Date(Math.ceil(input.endMs / 1000) * 1000)),
    )).orderBy(schema.vitals.timestamp).limit(100001).all()
    if (rows.length > 100000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Select a shorter comparison interval')
    return { reference, measurements, rows }
  })
  const references = snapshot.measurements.filter(row => row.metric === input.metric
    && (row.temporalKind === 'point'
      ? row.startMs >= input.startMs && row.startMs < input.endMs
      : row.startMs >= input.startMs && row.endMs <= input.endMs))
  // HRV in canonical vitals is exclusively the window IBI variability index.
  // A requested RMSSD/SDNN comparison therefore remains incompatible.
  const podMetric = input.metric.startsWith('hrv_') ? 'window_ibi_variability_v1' : input.metric
  const windowMs = podMetric === 'window_ibi_variability_v1' ? 300000 : null
  const observations = snapshot.rows.map(row => ({ timestampMs: row.timestamp.getTime(), value:
    podMetric === 'heart_rate' ? row.heartRate : podMetric === 'breathing_rate' ? row.breathingRate : row.hrv }))
  const alignment = alignReferences(podMetric, windowMs, observations, references,
    { ...DEFAULT_ALIGNMENT, pointToleranceMs: input.pointToleranceMs, clockOffsetMs: input.clockOffsetMs })
  const provenance = new Map<string | null, number>()
  for (const row of snapshot.rows) provenance.set(row.processingRunId, (provenance.get(row.processingRunId) ?? 0) + 1)
  const inputHash = dataHash({ input, referenceHash: snapshot.reference.summary.contentHash,
    observations: snapshot.rows.map(row => ({ ...row, timestamp: row.timestamp.getTime() })) })
  return comparisonReportSchema.parse({ ...alignment, requestedMetric: input.metric, version: 'stored-readings-comparison-v1', inputHash,
    side: input.side, subjectId: input.subjectId, startMs: input.startMs, endMs: input.endMs,
    importId: input.importId, importRevision: snapshot.reference.revision, source: snapshot.reference.summary.source,
    provenance: [...provenance].map(([processingRunId, count]) => ({ processingRunId, count })),
    limitations: [...alignment.limitations,
      'This compares original stored readings; it does not regenerate signals or validate a candidate.',
      'The input hash identifies this read snapshot; inputs are not retained until a dataset is frozen.',
      'Stored readings have no recorded support duration, so paired duration is unknown and reported as zero.',
      'Reference intervals crossing the selected boundaries are excluded to preserve their aggregation semantics.',
      ...(provenance.has(null) ? ['Some observations have legacy_unknown processing provenance.'] : [])],
  })
}
