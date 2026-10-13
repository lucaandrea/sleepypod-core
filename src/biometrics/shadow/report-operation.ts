import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { ReferenceInputError } from '../references/time'
import { ShadowStore } from './store'
import { reportShadowRun } from './report'
import { shadowReportRequestSchema, shadowReportSchema } from './report-contracts'

/** Coordinator-only bounded computation; no execution policy or worker needed.
 * Failure on oversized evidence is explicit, never a downsampled report. */
export function readShadowReport(db: Database.Database, raw: z.input<typeof shadowReportRequestSchema>) {
  const input = shadowReportRequestSchema.parse(raw)
  const store = new ShadowStore(db)
  try {
    const plan = store.get(input.id).plan
    if (input.reference && (input.reference.side !== plan.side || input.reference.subjectId !== plan.subjectId)) {
      throw new ReferenceInputError('SUBJECT_MISMATCH', 'Shadow reference must match the saved sleeper and side')
    }
    return shadowReportSchema.parse(reportShadowRun(store, input.id, { maximumPoints: 100000, maximumBytes: 32 * 1024 * 1024 }, input.reference))
  }
  catch (error) {
    if (error instanceof Error && error.message === 'Unknown shadow run') throw new ReferenceInputError('NOT_FOUND', 'Shadow run not found')
    if (error instanceof Error && error.message === 'Shadow report input limit exceeded') throw new ReferenceInputError('RESOURCE_LIMIT', 'Shadow report exceeds the bounded evidence limit')
    throw error
  }
}
