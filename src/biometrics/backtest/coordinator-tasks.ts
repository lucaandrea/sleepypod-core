import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { DatasetStore, createDatasetSchema } from './datasets'
import { BacktestJobStore, experimentProtocolSchema } from './jobs'
import { readStageTraces } from './traces'
import { traceRequestSchema } from './trace-contracts'
import { executeNextBacktest } from './runner'

const idInput = z.object({ id: z.string().uuid() }).strict()
export const coordinatorTaskSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('createDataset'), input: createDatasetSchema }).strict(),
  z.object({ type: z.literal('datasetDescriptor'), input: idInput }).strict(),
  z.object({ type: z.literal('readResult'), input: idInput }).strict(),
  z.object({ type: z.literal('readTrace'), input: traceRequestSchema }).strict(),
  z.object({ type: z.literal('releaseDataset'), input: idInput }).strict(),
  z.object({ type: z.literal('releaseResult'), input: idInput.extend({ expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/) }) }).strict(),
  z.object({ type: z.literal('createExperiment'), input: z.object({ datasetId: z.string().uuid(), protocol: experimentProtocolSchema, idempotencyKey: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ type: z.literal('collectArtifacts') }).strict(),
  z.object({ type: z.literal('execute'), owner: z.string().min(1).max(200) }).strict(),
])
export type CoordinatorTask = z.input<typeof coordinatorTaskSchema>
export interface CoordinatorResults {
  createDataset: ReturnType<DatasetStore['create']>
  datasetDescriptor: ReturnType<DatasetStore['descriptor']>
  readResult: ReturnType<BacktestJobStore['result']>
  readTrace: ReturnType<typeof readStageTraces>
  releaseDataset: ReturnType<DatasetStore['release']>
  releaseResult: ReturnType<BacktestJobStore['releaseResult']>
  createExperiment: ReturnType<BacktestJobStore['createExperiment']>
  collectArtifacts: null
  execute: Awaited<ReturnType<typeof executeNextBacktest>>
}

/** Fixed shipped operations; neither executable code nor paths come from RPC input. */
export async function performCoordinatorTask(db: BetterSQLite3Database<typeof schema>, raw: unknown, options: {
  workerPath: string
  signal: AbortSignal
  admit: () => Promise<boolean>
}) {
  const task = coordinatorTaskSchema.parse(raw)
  switch (task.type) {
    case 'createDataset': return new DatasetStore(db).create(task.input)
    case 'datasetDescriptor': return new DatasetStore(db).descriptor(task.input.id)
    case 'readResult': return new BacktestJobStore(db).result(task.input.id)
    case 'readTrace': return readStageTraces(db, task.input)
    case 'releaseDataset': return new DatasetStore(db).release(task.input.id)
    case 'releaseResult': return new BacktestJobStore(db).releaseResult(task.input.id, task.input.expectedContentHash)
    case 'createExperiment': return new BacktestJobStore(db).createExperiment(task.input.datasetId, task.input.protocol, task.input.idempotencyKey)
    case 'collectArtifacts':
      new BacktestJobStore(db).collectOrphanedArtifacts()
      return null
    case 'execute': return executeNextBacktest(db, { owner: task.owner, ...options })
  }
}
