import { sql } from 'drizzle-orm'
import { dirname, join } from 'node:path'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { z } from 'zod'
import type * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { createWaveformDatasetSchema, prepareSelectedWaveformDataset, selectedWaveformRetry } from './waveform-selection'
import { podRawInspectionLocation, type RawInspectionLocation } from './raw-inspection-child'
import { runRawPublicationChild } from './raw-publication-child'

/** Copy outside the live DB transaction. Python atomically publishes all refs;
 * a lost response or cancellation after commit is recovered by request identity. */
export async function publishSelectedWaveformDataset(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof createWaveformDatasetSchema>, options: {
  signal: AbortSignal
  admit: () => Promise<boolean>
  rawLocation?: RawInspectionLocation
}) {
  const input = createWaveformDatasetSchema.parse(raw)
  const existing = selectedWaveformRetry(db, input)
  if (existing) return { status: 'published' as const, dataset: existing }
  const deferred = { status: 'deferred' as const }
  const admitted = () => Promise.resolve().then(options.admit).catch(() => false)
  if (options.signal.aborted || !await admitted() || options.signal.aborted) return deferred
  const databasePath = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
  if (!databasePath) throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Waveform publication requires a persistent biometrics database')
  const work = prepareSelectedWaveformDataset(db, input)
  if (!await admitted() || options.signal.aborted) return deferred
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  let checking: Promise<void> | undefined, denied = false
  const timer = setInterval(() => {
    if (checking) return
    checking = admitted().then((allowed) => {
      if (!allowed) {
        denied = true
        controller.abort()
      }
    }).finally(() => { checking = undefined })
  }, 5000)
  try {
    const result = await runRawPublicationChild({ ...(options.rawLocation ?? podRawInspectionLocation), databasePath,
      retainedDirectory: join(dirname(databasePath), 'biometric-raw') }, work, { signal: controller.signal })
    const published = selectedWaveformRetry(db, input)
    if (!published || published.id !== result.id || published.contentHash !== result.contentHash) throw new Error('Published waveform identity mismatch')
    return { status: 'published' as const, dataset: published }
  }
  catch (error) {
    // A fully committed dataset remains published even if IPC was lost or a
    // stop raced with commit. Returning it never resurrects a released row.
    const published = selectedWaveformRetry(db, input)
    if (published) return { status: 'published' as const, dataset: published }
    if (denied) return deferred
    throw error
  }
  finally {
    clearInterval(timer)
    await checking
    options.signal.removeEventListener('abort', abort)
  }
}
