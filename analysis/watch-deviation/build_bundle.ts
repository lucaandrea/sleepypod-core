/**
 * Build an off-pod fitting bundle (the same tar the pod's dataset export
 * streams) from a pulled pod snapshot, without touching the pod.
 *
 * usage (in the container, repo root):
 *   [SP_SIDE=left|right] [SP_TIMEZONE=Area/City] npx tsx analysis/watch-deviation/build_bundle.ts <sessionId> [sessionId ...]
 * inputs:  $SP_ANALYSIS_DATA or data/ (paths.ts): biometrics.db, watch.json, archive/*.RAW.gz
 * outputs: out/work/ (scratch DB + retained copies), out/bundle.tar
 *
 * Steps mirror the pod's coordinator: import the Watch references, freeze a
 * processed dataset over the chosen sleep sessions, inspect the archives,
 * publish a waveform dataset over the sources that cover each cohort, export.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import * as schema from '@/src/db/biometrics-schema'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
import { ReferenceStore } from '@/src/biometrics/references/store'
import { DatasetStore } from '@/src/biometrics/backtest/datasets'
import { performCoordinatorTask } from '@/src/biometrics/backtest/coordinator-tasks'
import { RawSourceCatalog } from '@/src/biometrics/backtest/raw-catalog'
import { datasetBundleChunks, prepareDatasetExport } from '@/src/biometrics/backtest/dataset-export'
import { defaultPythonLocation } from '../../scripts/biometrics-local-fit/fit'
import { DATA, OUT } from './paths'

const sessionIds = process.argv.slice(2).map(Number)
if (sessionIds.length === 0 || sessionIds.some(n => !Number.isInteger(n))) throw new Error('usage: build_bundle.ts <sessionId> [...]')

const WORK = join(OUT, 'work')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
copyFileSync(join(DATA, 'biometrics.db'), join(WORK, 'biometrics.db'))
const sqlite = new Database(join(WORK, 'biometrics.db'))
sqlite.pragma('foreign_keys = ON')
const db = drizzle(sqlite, { schema })
migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })

const refs = JSON.parse(readFileSync(join(DATA, 'watch.json'), 'utf8')) as {
  hr: Array<[number, number]>
  rr: Array<[number, number]>
  stages: Array<[number, number, string]>
}
// One import holds at most 2000 rows, so keep only rows inside the chosen nights (±1 h).
const beds = sqlite.prepare(`select id, entered_bed_at * 1000 a, left_bed_at * 1000 b from sleep_records where id in (${sessionIds.map(() => '?').join(',')})`).all(...sessionIds) as Array<{ id: number, a: number, b: number }>
const inside = (t: number) => beds.some(w => t >= w.a - 3_600_000 && t <= w.b + 3_600_000)
refs.hr = refs.hr.filter(([t]) => inside(t))
refs.rr = refs.rr.filter(([t]) => inside(t))
refs.stages = refs.stages.filter(([a, b]) => inside(a) || inside(b))
console.log('reference rows', { hr: refs.hr.length, rr: refs.rr.length, stages: refs.stages.length })
const side = (process.env.SP_SIDE === 'right' ? 'right' : 'left') as 'left' | 'right'
// Local-noon night grouping depends on the sleeper's timezone, not the container's (UTC).
const timezone = process.env.SP_TIMEZONE || 'America/Los_Angeles'
const key = `watch-deviation-${side}-${sessionIds.join('-')}`
const subjectId = `${key}:${side}`
const rows = [
  ...refs.hr.map(([t, v]) => ({ recordKey: `hr:${t}`, metric: 'heart_rate', value: v, unit: 'bpm', timestampMs: t })),
  ...refs.rr.map(([t, v]) => ({ recordKey: `rr:${t}`, metric: 'breathing_rate', value: v, unit: 'breaths/min', timestampMs: t })),
  ...refs.stages.map(([a, b, s]) => ({ recordKey: `stage:${a}`, metric: 'sleep_stages', value: s, unit: 'stage', startMs: a, endMs: b })),
]
// One reference import holds at most 2000 rows; a dataset can pin several.
const referenceImportIds: string[] = []
for (let i = 0; i < rows.length; i += 2000) {
  const input = { side, subjectId, source: 'apple_watch', rows: rows.slice(i, i + 2000) }
  const preview = previewReferenceImport(input)
  referenceImportIds.push(new ReferenceStore(db).commit({ import: input, previewHash: preview.summary.contentHash }).id)
}
console.log('reference imports', referenceImportIds.length)

interface Assignment { cohortId: string, split: string, startMs: number, endMs: number, sessionIds: number[] }
const parent = new DatasetStore(db).create({ side, subjectId, sessionIds, referenceImportIds, timezone, idempotencyKey: key })
const assignments = (parent.manifest as { splitProtocol: { assignments: Assignment[] } }).splitProtocol.assignments
console.log('parent', parent.id, assignments.map(a => `${a.cohortId}:${a.split}`).join(' '))

const py = defaultPythonLocation()
// Inspecting every archive in a long pulled history is slow (one Python scan
// each), so stage only the archives that can cover the chosen nights: a frame
// is gzipped ~15 min after it closes, hence mtime in [entered − 20 min, left + 45 min],
// the same rule as fetch_raw.sh and the pod's analysis export. Hard links when
// the data folder shares a filesystem with out/, copies otherwise (e.g. a mount).
const source = join(DATA, 'archive')
const archive = join(WORK, 'archive')
mkdirSync(archive)
const staged = readdirSync(source).filter((name) => {
  if (!name.endsWith('.RAW.gz')) return false
  const mtime = statSync(join(source, name)).mtimeMs
  return beds.some(w => mtime >= w.a - 1_200_000 && mtime <= w.b + 2_700_000)
})
for (const name of staged) {
  try {
    linkSync(join(source, name), join(archive, name))
  }
  catch {
    copyFileSync(join(source, name), join(archive, name))
  }
}
console.log('staged archives', staged.length, 'of', readdirSync(source).length)
const options = { workerPath: '/nonexistent', rawLocation: { pythonPath: py.pythonPath, modulesPath: py.modulesPath, archiveDirectory: archive }, signal: new AbortController().signal, admit: async () => true }
let cursor: string | null = null
let scanned = 0
for (;;) {
  const result = await performCoordinatorTask(db, { type: 'inspectRawSource', input: { afterName: cursor } }, options) as { status: string, nextCursor: string | null }
  if (result.status === 'complete' || result.nextCursor === null) break
  cursor = result.nextCursor
  scanned++
}
console.log('inspected', scanned)

const catalog = new RawSourceCatalog(db)
const cohorts = assignments.map((a) => {
  const ids: string[] = []
  let afterId: string | undefined
  for (;;) {
    const page = catalog.page({ startMs: a.startMs - 300_000, endMs: a.endMs, ...(afterId ? { afterId } : {}) })
    // Only sources overlapping the cohort's own sessions: a cohort joining two
    // records across a daytime gap would otherwise exceed the 64-source limit.
    const sessions = beds.filter(b => a.sessionIds.includes(b.id))
    const overlaps = (first: number | null, last: number | null) => first != null && last != null && sessions.some(b => last >= b.a - 300_000 && first <= b.b)
    ids.push(...page.items.filter(i => i.inspection.inventory.ordered_waveform_available && existsSync(join(archive, i.inspection.source_name))
      && overlaps(i.inspection.inventory.first_event_ms, i.inspection.inventory.last_event_ms)).map(i => i.id))
    if (!page.nextCursor) break
    afterId = page.nextCursor
  }
  return { cohortId: a.cohortId, sourceIds: ids }
})
console.log('cohorts', cohorts.map(c => `${c.cohortId}:${c.sourceIds.length}`).join(' '))

const published = await performCoordinatorTask(db, { type: 'createWaveformDataset', input: { parentDatasetId: parent.id, expectedContentHash: parent.contentHash, cohorts, idempotencyKey: `${key}-wave` } }, options) as { status: string, dataset?: { id: string } }
if (!published.dataset) throw new Error(`waveform dataset not published: ${published.status}`)
const prepared = await prepareDatasetExport(db, published.dataset.id)
const out = createWriteStream(join(OUT, 'bundle.tar'))
for await (const chunk of datasetBundleChunks(prepared.index, { manifest: prepared.manifestText, snapshot: prepared.snapshotText }, join(WORK, 'biometric-raw'))) {
  if (!out.write(chunk)) await once(out, 'drain')
}
out.end()
await once(out, 'finish')
console.log('bundle', join(OUT, 'bundle.tar'), prepared.index.files.length, 'files')
