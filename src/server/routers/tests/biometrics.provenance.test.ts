// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/src/db', () => ({
  get biometricsDb() { return holder.db },
  get db() { return holder.db },
}))
const { biometricsRouter } = await import('../biometrics')

it('returns bounded recorded metadata and leaves legacy, missing, cross-side and corrupt provenance unknown', async () => {
  const sqlite = new Database(':memory:')
  try {
    const db = drizzle(sqlite, { schema })
    holder.db = db
    migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
    for (const [id, side, bundle] of [
      ['known', 'left', JSON.stringify({ manifestHash: 'b'.repeat(64), components: { hrv_index: { metricId: 'window_ibi_variability_v1' } }, privateExtra: 'not returned' })],
      ['other-side', 'right', JSON.stringify({ components: { hrv_index: { metricId: 'rmssd' } } })],
      ['corrupt', 'left', 'invalid json'],
      ['future', 'left', JSON.stringify({ manifestHash: 'c'.repeat(64), components: { hrv_index: { metricId: 'future_metric_v2' } } })],
    ]) {
      sqlite.prepare('INSERT INTO biometric_processing_runs (id,side,kind,bundle,config_hash,input_identity,started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, side, 'live', bundle, 'a'.repeat(64), '{}', 0)
    }
    for (const [index, id] of [null, 'known', 'missing', 'other-side', 'corrupt', 'future'].entries()) {
      db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(index * 1000), heartRate: 60, hrv: 30, processingRunId: id }).run()
    }
    const result = await biometricsRouter.createCaller({}).getVitals({ side: 'left', limit: 100 })
    expect(result).toHaveLength(6)
    const byRun = new Map(result.map(row => [row.processingRunId, row.provenance]))
    expect(byRun.get(null)).toMatchObject({ interpretation: 'original_observation', status: 'legacy_unknown', configurationHash: null, hrvMetricId: null })
    expect(byRun.get('known')).toMatchObject({ status: 'recorded', configurationHash: 'a'.repeat(64), hrvMetricId: 'window_ibi_variability_v1' })
    for (const id of ['missing', 'other-side']) expect(byRun.get(id)).toMatchObject({ status: 'unavailable', configurationHash: null, hrvMetricId: null })
    expect(byRun.get('corrupt')).toMatchObject({ hrvMetricId: null })
    expect(byRun.get('future')).toMatchObject({ hrvMetricId: 'future_metric_v2' })
    expect(JSON.stringify(result)).not.toContain('privateExtra')
    expect(JSON.stringify(result)).not.toContain('not returned')
    const caller = biometricsRouter.createCaller({})
    const range = { side: 'left' as const, startDate: new Date(0), endDate: new Date(6000) }
    const summary = await caller.getVitalsSummary(range)
    expect(summary).toMatchObject({ avgHRV: null, recordCount: 6, provenance: {
      interpretation: 'original_observations', configurationCount: 2, unknownConfigurationRows: 4,
      hrvRows: 6, hrvDefinitionCount: 2, unknownHrvRows: 4, hrvMetricId: null, hrvAggregation: 'incompatible_definitions',
    } })
    // Baselines use the same complete SQL aggregates, independently of chart pagination.
    sqlite.prepare('UPDATE vitals SET timestamp = timestamp + ?').run(Math.floor(Date.now() / 1000) - 60)
    expect(await caller.getVitalsBaseline({ side: 'left', days: 1 })).toMatchObject({ hrvMean: null, hrvSD: null,
      provenance: { hrvAggregation: 'incompatible_definitions', configurationCount: 2 } })
    sqlite.prepare('DELETE FROM vitals WHERE processing_run_id IS NULL OR processing_run_id != \'known\'').run()
    expect(await caller.getVitalsBaseline({ side: 'left', days: 1 })).toMatchObject({ hrvMean: 30, hrvSD: 0,
      provenance: { configurationCount: 1, unknownConfigurationRows: 0, hrvAggregation: 'single_definition', hrvMetricId: 'window_ibi_variability_v1' } })
    // Equal resolved values do not merge different engine manifests into a baseline.
    sqlite.prepare('UPDATE biometric_processing_runs SET bundle = ? WHERE id = ?').run(JSON.stringify({
      manifestHash: 'c'.repeat(64), components: { hrv_index: { metricId: 'window_ibi_variability_v1' } },
    }), 'future')
    db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(Date.now() - 1000), heartRate: 70, hrv: 40, breathingRate: 16, processingRunId: 'future' }).run()
    expect(await caller.getVitalsBaseline({ side: 'left', days: 1 })).toMatchObject({ hrMean: null, hrSD: null, hrvMean: null, hrvSD: null, brMean: null, brSD: null,
      provenance: { configurationCount: 2, unknownConfigurationRows: 0, hrvAggregation: 'single_definition' } })
    sqlite.prepare('DELETE FROM vitals WHERE processing_run_id = \'future\'').run()
    sqlite.prepare('UPDATE vitals SET processing_run_id = NULL').run()
    expect(await caller.getVitalsBaseline({ side: 'left', days: 1 })).toMatchObject({ hrvMean: 30,
      provenance: { hrvDefinitionCount: 0, unknownHrvRows: 1, hrvAggregation: 'legacy_unverified', hrvMetricId: null } })
  }
  finally { sqlite.close() }
})
