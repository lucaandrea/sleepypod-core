import { DatasetStore } from './datasets'
import { pageReferenceTraces, referenceTraceIdentity, referenceTraceRequestSchema } from './reference-trace-page'
import { pageNumericTraces } from './numeric-trace-page'
import type { z } from 'zod'
import { pageStageTraces } from './trace-page'
export { pageStageTraces } from './trace-page'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { BacktestJobStore } from './jobs'
import { traceRequestSchema } from './trace-contracts'

export function readStageTraces(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof traceRequestSchema>) {
  const input = traceRequestSchema.parse(raw)
  const result = new BacktestJobStore(db).result(input.id)
  if (!result) throw new ReferenceInputError('INVALID_STATE', 'Wait for a successful replay before reading traces')
  if (result.contentHash !== input.expectedContentHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Trace report hash changed')
  if (!result.available) throw new ReferenceInputError('RESULT_RELEASED', 'Replay report was released')
  return pageStageTraces(result.report, input)
}

export function readNumericTraces(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof traceRequestSchema>) {
  const input = traceRequestSchema.parse(raw)
  const result = new BacktestJobStore(db).result(input.id)
  if (!result) throw new ReferenceInputError('INVALID_STATE', 'Wait for a successful replay before reading traces')
  if (result.contentHash !== input.expectedContentHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Trace report hash changed')
  if (!result.available) throw new ReferenceInputError('RESULT_RELEASED', 'Replay report was released')
  return pageNumericTraces(result.report, input)
}

export function readReferenceTraces(db: BetterSQLite3Database<typeof schema>, raw: z.input<typeof referenceTraceRequestSchema>) {
  const input = referenceTraceRequestSchema.parse(raw)
  const result = new BacktestJobStore(db).result(input.id)
  if (!result) throw new ReferenceInputError('INVALID_STATE', 'Wait for a successful replay before reading references')
  if (result.contentHash !== input.expectedContentHash) throw new ReferenceInputError('REVISION_CONFLICT', 'Reference report hash changed')
  if (!result.available) throw new ReferenceInputError('RESULT_RELEASED', 'Replay report was released')
  const identity = referenceTraceIdentity(result.report)
  const dataset = new DatasetStore(db).read(identity.datasetId)
  return pageReferenceTraces(result.report, dataset, input)
}
