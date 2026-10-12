import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { CoordinatorQueue } from './coordinator-queue'
import { packagedCoordinatorPath, packagedWorkerPath } from './location'
import type { CoordinatorTask } from './coordinator-tasks'

const shared = globalThis as typeof globalThis & { __biometricCoordinator?: { path: string, queue: CoordinatorQueue } }
export function coordinatorRequest<T extends CoordinatorTask>(db: BetterSQLite3Database<typeof schema>, task: T, control: {
  signal?: AbortSignal
  admit?: () => Promise<boolean>
} = {}) {
  const path = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
  if (!path) throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Coordinator requires a persistent biometrics database')
  if (shared.__biometricCoordinator && shared.__biometricCoordinator.path !== path) throw new Error('Stop the coordinator before changing its database')
  shared.__biometricCoordinator ??= { path, queue: new CoordinatorQueue({ databasePath: path,
    coordinatorPath: packagedCoordinatorPath(), workerPath: packagedWorkerPath() }) }
  return shared.__biometricCoordinator.queue.request(task, control)
}
export async function stopBiometricCoordinator() {
  const current = shared.__biometricCoordinator
  if (!current) return
  await current.queue.stop()
  if (shared.__biometricCoordinator === current) delete shared.__biometricCoordinator
}
