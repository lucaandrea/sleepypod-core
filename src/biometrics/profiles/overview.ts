import { desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { resolveStageClassifier } from '@/src/lib/sleep-stage-rules'
import { ProfileStore } from './store'
import { resolveStageView } from './stage-view'
import { runtimeHealth } from './health'

/** Read-only inspection keeps desired intent separate from runtime evidence. */
export function profileOverview(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, side: 'left' | 'right', now = Date.now()) {
  const profiles = new ProfileStore(configDb)
  const desired = profiles.effective(side)
  const legacy = configDb.select({ classifier: configSchema.sideSettings.stageClassifier }).from(configSchema.sideSettings).where(eq(configSchema.sideSettings.side, side)).get()
  const receipts = bioDb.select().from(bioSchema.biometricRuntimeReceipts).where(eq(bioSchema.biometricRuntimeReceipts.side, side))
    .orderBy(desc(bioSchema.biometricRuntimeReceipts.generation), desc(bioSchema.biometricRuntimeReceipts.heartbeatAtMs)).limit(20).all()
  const latest = receipts.filter((row, index) => receipts.findIndex(other => other.component === row.component) === index)
  const sensorCalibration = bioDb.select().from(bioSchema.calibrationProfiles).where(eq(bioSchema.calibrationProfiles.side, side)).all()
    .map(row => ({ id: row.id, sensorType: row.sensorType, status: row.status, qualityScore: row.qualityScore,
      createdAtMs: row.createdAt.getTime(), expiresAtMs: row.expiresAt?.getTime() ?? null,
      freshness: row.status !== 'completed' || row.expiresAt === null ? 'unknown' as const : row.expiresAt.getTime() <= now ? 'expired' as const : 'current' as const,
      sourceWindowStartMs: row.sourceWindowStart === null ? null : row.sourceWindowStart * 1000,
      sourceWindowEndMs: row.sourceWindowEnd === null ? null : row.sourceWindowEnd * 1000,
    }))
  return { desired, stageView: resolveStageView(configDb, bioDb, side),
    legacyStageView: { classifier: resolveStageClassifier(legacy?.classifier), personalized: legacy?.classifier != null,
      migrationPending: legacy?.classifier != null && desired.binding.generation === 0 },
    runtimeHealth: runtimeHealth(latest, now),
    runtimeStatus: latest.length ? 'receipts_available' as const : 'unreported' as const, receipts: latest, sensorCalibration,
    activationAvailable: true,
    limitations: ['Desired configuration is not proof of runtime adoption.', 'Measured sensor calibration is independent of algorithm personalization.',
      'Manual changes are unvalidated; applied status requires matching component receipts.'],
  }
}
