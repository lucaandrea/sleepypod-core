import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Dedicated off-pod experiment metadata. Never migrate this schema into either
// sleepypod.db or biometrics.db; it contains no canonical hardware/vitals data.
export const packageStudies = sqliteTable('package_studies', {
  id: text('id').primaryKey(), hash: text('hash').notNull().unique(), payload: text('payload').notNull(),
})
export const packageTrials = sqliteTable('package_trials', {
  id: text('id').primaryKey(), idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(), request: text('request').notNull(), state: text('state').notNull(),
  attemptId: text('attempt_id'), leaseUntil: integer('lease_until'), reportHash: text('report_hash'),
})
export const packageExposures = sqliteTable('package_exposures', {
  attemptId: text('attempt_id').notNull(), trialId: text('trial_id').notNull(), nightId: text('night_id').notNull(),
  subjectId: text('subject_id').notNull(), side: text('side').notNull(),
  startMs: integer('start_ms').notNull(), endMs: integer('end_ms').notNull(), split: text('split').notNull(), observedAt: integer('observed_at').notNull(),
}, table => [primaryKey({ columns: [table.attemptId, table.nightId] }), index('package_exposure_window').on(table.subjectId, table.side, table.startMs, table.endMs)])
