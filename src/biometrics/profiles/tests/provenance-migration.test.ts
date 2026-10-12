// @vitest-environment node
import Database from 'better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { expect, it } from 'vitest'

it('preserves old vitals through additive migration and accepts old writers afterward', () => {
  const sqlite = new Database(':memory:')
  try {
    const migrations = readMigrationFiles({ migrationsFolder: 'src/db/biometrics-migrations' })
    const provenanceIndex = migrations.findIndex(migration => migration.sql.some(statement => statement.includes('ADD `processing_run_id`')))
    expect(provenanceIndex).toBeGreaterThan(0)
    for (const migration of migrations.slice(0, provenanceIndex)) {
      for (const statement of migration.sql) sqlite.exec(statement)
    }
    const insert = 'INSERT INTO vitals(side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)'
    sqlite.prepare(insert).run('left', 1700000000, 60, 12, 15)
    for (const migration of migrations.slice(provenanceIndex)) {
      for (const statement of migration.sql) sqlite.exec(statement)
    }
    expect(sqlite.prepare('SELECT heart_rate, hrv, processing_run_id FROM vitals').get())
      .toEqual({ heart_rate: 60, hrv: 12, processing_run_id: null })
    sqlite.prepare(insert).run('right', 1700000060, null, null, 16)
    expect(sqlite.prepare('SELECT count(*) AS total FROM vitals WHERE processing_run_id IS NULL').get()).toEqual({ total: 2 })
  }
  finally { sqlite.close() }
})
