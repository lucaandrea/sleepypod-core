import { and, asc, eq, gt, gte, isNull, lt, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../algorithms/canonical'
import { ReferenceInputError } from '../references/time'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export { rawArtifactDescriptorSchema } from './waveform-contracts'
import { rawArtifactDescriptorSchema } from './waveform-contracts'
const channel = z.object({ samples: count, lost_markers: count, truncated_tail_bytes: count }).strict()
export const rawInventorySchema = z.object({
  version: z.literal('retained-raw-inventory-v1'), artifact_sha256: hash,
  decoded_records: count, piezo_records: count, pump_records: count,
  usable_dual_frames: count, empty_channel_frames: count, oversize_channel_frames: count,
  invalid_timestamps: count, timestamp_reversals: count, duplicate_timestamps: count,
  first_event_ms: count.nullable(), last_event_ms: count.nullable(),
  channels: z.object({ left1: channel, right1: channel }).strict(),
  ordered_waveform_available: z.boolean(), limitations: z.array(z.string().max(500)).max(10),
}).strict().superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message })
  if ((value.first_event_ms === null) !== (value.last_event_ms === null)
    || (value.first_event_ms !== null && value.last_event_ms !== null && value.first_event_ms > value.last_event_ms)) invalid('Invalid event bounds')
  if (value.piezo_records + value.pump_records > value.decoded_records
    || value.usable_dual_frames + value.empty_channel_frames + value.oversize_channel_frames !== value.piezo_records) invalid('Inconsistent record counts')
  for (const totals of Object.values(value.channels)) {
    if (totals.lost_markers > totals.samples) invalid('Lost markers exceed sample count')
  }
  const ordered = value.usable_dual_frames > 0 && value.invalid_timestamps === 0
    && value.timestamp_reversals === 0 && value.oversize_channel_frames === 0
  if (value.ordered_waveform_available !== ordered || (ordered && value.first_event_ms === null)) invalid('Inconsistent waveform availability')
})
export const rawInspectionSchema = z.object({
  source_name: z.string().max(255).regex(/^[A-Za-z0-9_.-]+\.RAW\.gz$/),
  retained: z.literal(false), artifact: rawArtifactDescriptorSchema, inventory: rawInventorySchema,
}).strict().refine(value => value.artifact.sha256 === value.inventory.artifact_sha256, 'Inventory must identify the inspected bytes')

export const rawSourceDescriptorSchema = z.object({
  id: hash, inspection: rawInspectionSchema, inspectedAtMs: count, unavailableAtMs: count.nullable(),
  availability: z.enum(['requires_reverification', 'unavailable']),
}).strict()
export const rawSourcePageResultSchema = z.object({ items: z.array(rawSourceDescriptorSchema).max(50), nextCursor: hash.nullable() }).strict()

export const rawSourcePageSchema = z.object({ startMs: count, endMs: count, afterId: hash.optional() }).strict()
  .refine(value => value.endMs > value.startMs, 'Expected a nonempty time window')

/** Internal scan evidence only. This catalog neither retains bytes nor grants replay capability. */
export class RawSourceCatalog {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>, private readonly now = Date.now) {}

  record(raw: unknown) {
    const input = rawInspectionSchema.parse(raw)
    const id = configHash({ sourceName: input.source_name, artifactHash: input.artifact.sha256, inventoryVersion: input.inventory.version })
    const inspectedAtMs = count.parse(this.now())
    return this.db.transaction((tx) => {
      const existing = tx.select().from(schema.biometricRawSources).where(eq(schema.biometricRawSources.id, id)).get()
      if (existing && (configHash(existing.descriptor) !== configHash(input.artifact)
        || configHash(existing.inventory) !== configHash(input.inventory))) {
        throw new ReferenceInputError('SOURCE_CONFLICT', 'Identical source bytes and inventory version produced different inspection evidence')
      }
      // Replacement invalidates only previous identities of this filename. It
      // never changes their frozen descriptor or any dataset's retained bytes.
      tx.update(schema.biometricRawSources).set({ unavailableAtMs: inspectedAtMs })
        .where(and(eq(schema.biometricRawSources.sourceName, input.source_name), ne(schema.biometricRawSources.id, id), isNull(schema.biometricRawSources.unavailableAtMs))).run()
      tx.insert(schema.biometricRawSources).values({ id, sourceName: input.source_name,
        artifactHash: input.artifact.sha256, descriptor: input.artifact, inventoryVersion: input.inventory.version,
        inventory: input.inventory, firstEventMs: input.inventory.first_event_ms, lastEventMs: input.inventory.last_event_ms,
        inspectedAtMs, unavailableAtMs: null,
      }).onConflictDoUpdate({ target: schema.biometricRawSources.id, set: { inspectedAtMs, unavailableAtMs: null } }).run()
      return id
    }, { behavior: 'immediate' })
  }

  markUnavailable(id: string) {
    // Mark the failed inspected identity, not a filename that may now point at
    // a newer successful scan. Existing tombstone timestamps remain stable.
    this.db.update(schema.biometricRawSources).set({ unavailableAtMs: count.parse(this.now()) })
      .where(and(eq(schema.biometricRawSources.id, hash.parse(id)), isNull(schema.biometricRawSources.unavailableAtMs))).run()
  }

  read(id: string) {
    const row = this.db.select().from(schema.biometricRawSources).where(eq(schema.biometricRawSources.id, hash.parse(id))).get()
    if (!row) throw new ReferenceInputError('NOT_FOUND', 'Inspected RAW source not found')
    const inspection = rawInspectionSchema.parse({ source_name: row.sourceName, retained: false, artifact: row.descriptor, inventory: row.inventory })
    if (row.artifactHash !== inspection.artifact.sha256 || row.inventoryVersion !== inspection.inventory.version
      || row.firstEventMs !== inspection.inventory.first_event_ms || row.lastEventMs !== inspection.inventory.last_event_ms
      || row.id !== configHash({ sourceName: row.sourceName, artifactHash: row.artifactHash, inventoryVersion: row.inventoryVersion })) {
      throw new ReferenceInputError('SOURCE_CORRUPT', 'Inspected RAW source integrity check failed')
    }
    return { id: row.id, inspection, inspectedAtMs: row.inspectedAtMs, unavailableAtMs: row.unavailableAtMs,
      availability: row.unavailableAtMs === null ? 'requires_reverification' as const : 'unavailable' as const }
  }

  page(raw: { startMs: number, endMs: number, afterId?: string }) {
    const input = rawSourcePageSchema.parse(raw)
    // Event bounds are inclusive; requested windows are half-open. Inclusion
    // only indicates potential overlap, never continuous or complete coverage.
    const rows = this.db.select({ id: schema.biometricRawSources.id }).from(schema.biometricRawSources)
      .where(and(isNull(schema.biometricRawSources.unavailableAtMs), lt(schema.biometricRawSources.firstEventMs, input.endMs),
        gte(schema.biometricRawSources.lastEventMs, input.startMs), input.afterId ? gt(schema.biometricRawSources.id, input.afterId) : undefined))
      .orderBy(asc(schema.biometricRawSources.id)).limit(51).all()
    const items = rows.slice(0, 50).map(row => this.read(row.id))
    return { items, nextCursor: rows.length > 50 ? items[49].id : null }
  }
}
