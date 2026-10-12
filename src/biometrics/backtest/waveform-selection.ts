import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { DatasetStore } from './datasets'
import { datasetManifestSchema, type DatasetSnapshot } from './contracts'
import { RawSourceCatalog } from './raw-catalog'
import { prepareWaveformDataset } from './waveform-dataset'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const createWaveformDatasetSchema = z.object({
  parentDatasetId: z.string().uuid(), expectedContentHash: hash,
  cohorts: z.array(z.object({ cohortId: z.string().min(1).max(200),
    sourceIds: z.array(hash).min(1).max(64),
  }).strict()).min(1).max(60),
  idempotencyKey: z.string().min(1).max(200),
}).strict()

/** Only intervals actually recorded in the frozen parent are evidence. Session
 * boundaries are not evidence of continuous occupancy, nor of sleeper mode. */
export function recordedWaveformContexts(snapshot: DatasetSnapshot, startMs: number, endMs: number) {
  const events = new Map<number, [number, number]>()
  let count = 0
  for (const session of snapshot.sessions) {
    for (const [raw, state] of [[session.presentIntervals, 0], [session.notPresentIntervals, 1]] as const) {
      if (!Array.isArray(raw)) continue
      for (const item of raw) {
        if (++count > 20000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Recorded occupancy interval budget exceeded')
        // The sleep detector stores epoch seconds (including fractional seconds).
        if (!Array.isArray(item) || item.length !== 2 || item.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) continue
        const first = Math.round(item[0] * 1000), last = Math.round(item[1] * 1000)
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first >= last) continue
        const start = Math.max(first, startMs, session.startMs), end = Math.min(last, endMs, session.endMs)
        if (start >= end) continue
        for (const [time, delta] of [[start, 1], [end, -1]]) {
          const event = events.get(time) ?? [0, 0]
          event[state] += delta
          events.set(time, event)
        }
      }
    }
  }
  const times = [...events.keys()].sort((a, b) => a - b)
  let present = 0, absent = 0
  const contexts: Array<{
    start_ms: number
    end_ms: number
    active_sides: null
    left_occupied: boolean | null
    right_occupied: boolean | null
    pump_context_known: false
  }> = []
  for (let index = 0; index < times.length - 1; index++) {
    const [yes, no] = events.get(times[index]) ?? [0, 0]
    present += yes
    absent += no
    // Conflicting evidence and unrecorded gaps both remain unknown.
    if ((present > 0) === (absent > 0)) continue
    const occupied = present > 0
    const last = contexts.at(-1)
    if (last && last.end_ms === times[index] && last[`${snapshot.side}_occupied`] === occupied) last.end_ms = times[index + 1]
    else contexts.push({ start_ms: times[index], end_ms: times[index + 1], active_sides: null,
      left_occupied: snapshot.side === 'left' ? occupied : null,
      right_occupied: snapshot.side === 'right' ? occupied : null, pump_context_known: false })
  }
  if (contexts.length > 20000) throw new ReferenceInputError('RESOURCE_LIMIT', 'Recorded occupancy context budget exceeded')
  return contexts
}

/** Resolve IDs to verified catalog evidence and frozen historical context. No
 * archive reads or live configuration queries occur while the DB snapshot is held. */
export function prepareSelectedWaveformDataset(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof createWaveformDatasetSchema>, now = Date.now()) {
  const input = createWaveformDatasetSchema.parse(raw)
  if (new Set(input.cohorts.map(item => item.cohortId)).size !== input.cohorts.length) throw new ReferenceInputError('DUPLICATE_SELECTION', 'Select each whole-night cohort once')
  return db.transaction(() => {
    const parent = new DatasetStore(db).read(input.parentDatasetId)
    if (parent.contentHash !== input.expectedContentHash) throw new ReferenceInputError('DATASET_CHANGED', 'Select the expected immutable parent dataset')
    const manifest = datasetManifestSchema.parse(parent.manifest)
    if (input.cohorts.length !== manifest.splitProtocol.assignments.length) throw new ReferenceInputError('INSUFFICIENT_RAW_DATA', 'Select RAW inputs for every whole-night cohort')
    const catalog = new RawSourceCatalog(db)
    const selections = new Map<string, { source_name: string, artifact: ReturnType<RawSourceCatalog['read']>['inspection']['artifact'] }>()
    const inputs = manifest.splitProtocol.assignments.map((cohort) => {
      const selection = input.cohorts.find(item => item.cohortId === cohort.cohortId)
      if (!selection) throw new ReferenceInputError('INSUFFICIENT_RAW_DATA', 'Missing whole-night RAW selection')
      if (new Set(selection.sourceIds).size !== selection.sourceIds.length) throw new ReferenceInputError('DUPLICATE_SELECTION', 'Select each RAW source once per cohort')
      const artifacts = selection.sourceIds.map((id) => {
        const source = catalog.read(id)
        const { inventory, artifact, source_name } = source.inspection
        if (source.unavailableAtMs !== null || !inventory.ordered_waveform_available
          || inventory.first_event_ms === null || inventory.last_event_ms === null) {
          throw new ReferenceInputError('INSUFFICIENT_RAW_DATA', 'Selected RAW source is unavailable or cannot provide ordered waveforms')
        }
        const previous = selections.get(artifact.sha256)
        if (!previous || source_name < previous.source_name) selections.set(artifact.sha256, { source_name, artifact })
        return { artifact, first_event_ms: inventory.first_event_ms, last_event_ms: inventory.last_event_ms }
      }).sort((a, b) => a.first_event_ms - b.first_event_ms || a.artifact.sha256.localeCompare(b.artifact.sha256))
      const start = Math.max(0, cohort.startMs - 300000)
      return { cohortId: cohort.cohortId, input: { version: 'retained-waveform-input-v1' as const,
        retained_start_ms: start, score_start_ms: cohort.startMs, score_end_ms: cohort.endMs,
        artifacts, contexts: recordedWaveformContexts(parent.snapshot, start, cohort.endMs) } }
    })
    const prepared = prepareWaveformDataset({ ...parent, manifest }, inputs, input.idempotencyKey, now)
    return { prepared, selections: [...selections.values()].sort((a, b) => a.artifact.sha256.localeCompare(b.artifact.sha256)) }
  })
}
