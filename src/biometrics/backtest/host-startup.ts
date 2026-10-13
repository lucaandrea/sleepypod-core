import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { configuredReplayPolicy, replayAdmitter, replayHealthAdmission } from './admission-service'
import { startBacktestHost } from './host'

/** Enable polling only for an explicitly configured deployment. Startup does
 * not substitute for qualification or fresh health checks on every operation. */
export function startConfiguredBacktestHost(db: BetterSQLite3Database<typeof schema>) {
  if (!configuredReplayPolicy()) return null
  return startBacktestHost(db, replayAdmitter(db), replayHealthAdmission(db))
}
