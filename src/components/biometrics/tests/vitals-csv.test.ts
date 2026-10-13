import { expect, it } from 'vitest'
import { generateVitalsCSV } from '../vitals-csv'

const vital = { timestamp: new Date(0), side: 'left', heartRate: 60, hrv: 30, breathingRate: null }
it('preserves original values and appends exact recorded identity without inventing legacy HRV meaning', () => {
  const csv = generateVitalsCSV([vital, { ...vital, provenance: { interpretation: 'original_observation', status: 'recorded',
    processingRunId: 'run-1', configurationHash: 'a'.repeat(64), hrvMetricId: 'window_ibi_variability_v1' } }])
  const rows = csv.split('\n')
  expect(rows[0]).toBe('timestamp,heart_rate,hrv,breathing_rate,side,interpretation,processing_run_id,provenance_status,configuration_hash,hrv_metric_id')
  expect(rows[1]).toBe('1970-01-01T00:00:00.000Z,60,30,,left,original_observation,,legacy_unknown,,unknown')
  expect(rows[2]).toContain(`,run-1,recorded,${'a'.repeat(64)},window_ibi_variability_v1`)
})
it('does not turn a missing run into known provenance and escapes metadata cells', () => {
  expect(generateVitalsCSV([{ ...vital, processingRunId: '=SUM(1,2)' }])).toContain('"\'=SUM(1,2)",unavailable,,unknown')
  expect(generateVitalsCSV([{ ...vital, processingRunId: 'a"b\nc' }])).toContain('"a""b\nc",unavailable,,unknown')
})
