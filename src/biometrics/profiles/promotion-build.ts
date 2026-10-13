import { installedPromotionPolicies } from './qualification-registry'
import { packagedWorkerPath } from '../backtest/location'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as bioSchema from '@/src/db/biometrics-schema'
import { BacktestJobStore } from '../backtest/jobs'
import { backtestJobSnapshotSchema } from '../backtest/contracts'
import { resolveInstalledReplayBuild } from '../backtest/submission'
import type { PromotionBuild } from './evaluation-store'

/** This registry is server owned. Frozen client thresholds cannot designate a
 * policy; qualified production policies must be installed explicitly. */
export async function resolvePromotionBuild(bioDb: BetterSQLite3Database<typeof bioSchema>, evaluationId: string): Promise<PromotionBuild> {
  const job = new BacktestJobStore(bioDb).get(evaluationId)
  const snapshot = backtestJobSnapshotSchema.parse(job.input)
  const identity = await resolveInstalledReplayBuild(snapshot.protocol.mode)
  return { ...identity, designations: await installedPromotionPolicies(packagedWorkerPath(), { ...identity, protocolHash: snapshot.protocolHash }) }
}
