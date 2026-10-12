// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'

const holder = vi.hoisted(() => ({ bio: null as unknown }))
vi.mock('@/src/db', () => ({
  get biometricsDb() { return holder.bio },
}))
const { biometricTuningRouter } = await import('../biometricTuning')
const caller = biometricTuningRouter.createCaller({})
let sqlite: Database.Database
const input = { side: 'left' as const, source: 'generic-test', subjectId: 'sleeper-A', rows: [
  { recordKey: 'hr-1', metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: 1791673200000 },
] }

beforeEach(() => {
  sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  holder.bio = db
})
afterEach(() => sqlite.close())

describe('shared biometric reference API', () => {
  it('completes preview, commit, paginated read and explicit deletion without touching live vitals', async () => {
    const preview = await caller.previewImport(input)
    expect(preview).toMatchObject({ accepted: 1, rejected: 0, side: 'left', subjectId: 'sleeper-A' })
    expect('measurements' in preview).toBe(false)
    const committed = await caller.commitImport({ import: input, previewHash: preview.contentHash })
    expect((await caller.listImports({ side: 'left' })).items[0].id).toBe(committed.id)
    expect((await caller.listImports({ side: 'right' })).items).toEqual([])
    expect((await caller.getImportMeasurements({ id: committed.id, limit: 1 })).items[0].value).toBe(60)
    expect(await caller.commitImport({ import: input, previewHash: preview.contentHash })).toMatchObject({ id: committed.id, alreadyImported: true })
    await caller.deleteImport({ id: committed.id })
    expect(await caller.getImport({ id: committed.id })).toMatchObject({ available: false })
    await expect(caller.getImportMeasurements({ id: committed.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(sqlite.prepare('SELECT count(*) AS total FROM vitals').get()).toEqual({ total: 0 })
  })

  it('reports stale preview and partial-import errors through actionable typed envelopes', async () => {
    const preview = await caller.previewImport(input)
    await expect(caller.commitImport({ import: { ...input, subjectId: 'different-sleeper' }, previewHash: preview.contentHash })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('STALE_PREVIEW') })
    const invalid = { ...input, rows: [...input.rows, { filename: '../../etc/passwd' }] }
    const partial = await caller.previewImport(invalid)
    await expect(caller.commitImport({ import: invalid, previewHash: partial.contentHash })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('REJECTED_ROWS') })
    await expect(caller.listImports({ side: 'left', beforeCreatedAtMs: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('compares complete stored readings with exact source and side mapping without rewriting history', async () => {
    const startMs = 1791673200000
    sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)').run('left', startMs / 1000, 65)
    sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)').run('right', startMs / 1000, 120)
    const preview = await caller.previewImport(input)
    const reference = await caller.commitImport({ import: input, previewHash: preview.contentHash })
    const request = { side: 'left' as const, subjectId: input.subjectId, importId: reference.id, metric: 'heart_rate' as const, startMs, endMs: startMs + 3600000 }
    const report = await caller.compareReadings(request)
    expect(report).toMatchObject({ status: 'compared', pairedCount: 1, metrics: { mae: 5, signedBias: 5 }, provenance: [{ processingRunId: null, count: 1 }] })
    expect(report.limitations.join(' ')).toContain('legacy_unknown')
    expect((await caller.compareReadings(request)).inputHash).toBe(report.inputHash)
    await expect(caller.compareReadings({ ...request, side: 'right' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('SUBJECT_MISMATCH') })
    await expect(caller.compareReadings({ ...request, endMs: startMs + 86400001 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    sqlite.prepare('UPDATE vitals SET heart_rate = 70 WHERE side = ?').run('left')
    expect((await caller.compareReadings(request)).inputHash).not.toBe(report.inputHash)
    expect(sqlite.prepare('SELECT count(*) AS total FROM vitals').get()).toEqual({ total: 2 })
  })

  it('blocks scoring clinical HRV against the window index and reports missing readings', async () => {
    const startMs = 1791673200000
    const upload = { ...input, rows: [{ recordKey: 'rmssd', metric: 'hrv_rmssd', value: 40, unit: 'ms', timestampMs: startMs, windowMs: 300000 }] }
    sqlite.prepare('INSERT INTO vitals (side, timestamp, hrv) VALUES (?, ?, ?)').run('left', startMs / 1000, 40)
    const preview = await caller.previewImport(upload)
    const reference = await caller.commitImport({ import: upload, previewHash: preview.contentHash })
    const request = { side: 'left' as const, subjectId: input.subjectId, importId: reference.id, metric: 'hrv_rmssd' as const, startMs, endMs: startMs + 3600000 }
    expect(await caller.compareReadings(request)).toMatchObject({ status: 'incompatible', metrics: null, pairedCount: 0, exclusions: { incompatible_metric_definition: 1 } })
    const hrPreview = await caller.previewImport(input)
    const hr = await caller.commitImport({ import: input, previewHash: hrPreview.contentHash })
    expect(await caller.compareReadings({ ...request, importId: hr.id, metric: 'heart_rate' })).toMatchObject({ status: 'no_overlap', metrics: null, outputCoverage: 0 })
    await caller.deleteImport({ id: hr.id })
    await expect(caller.compareReadings({ ...request, importId: hr.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('generates usable OpenAPI contracts for the actual shared router', () => {
    const document = generateOpenApiDocument(biometricTuningRouter, { title: 'References', version: '1.0.0', baseUrl: 'http://localhost/api' })
    expect(document.paths?.['/biometric-tuning/references/preview']?.post).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/{id}/measurements']?.get).toBeDefined()
    expect(document.paths?.['/biometric-tuning/references/{id}']?.delete).toBeDefined()
  })
})
