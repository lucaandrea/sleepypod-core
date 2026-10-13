import type { VitalProvenance } from '@/src/biometrics/profiles/vital-provenance'

interface ExportVital {
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
  side: string
  processingRunId?: string | null
  provenance?: VitalProvenance
}
function cell(value: unknown): string {
  const text = value == null ? '' : String(value)
  // Metadata is data even when a malformed/imported identifier resembles a formula.
  const safe = typeof value === 'string' && /^[=+@\-\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}
export function generateVitalsCSV(vitals: ExportVital[]): string {
  const header = 'timestamp,heart_rate,hrv,breathing_rate,side,interpretation,processing_run_id,provenance_status,configuration_hash,hrv_metric_id'
  const rows = vitals.map(v => [new Date(v.timestamp).toISOString(), v.heartRate, v.hrv, v.breathingRate, v.side,
    'original_observation', v.provenance?.processingRunId ?? v.processingRunId,
    v.provenance?.status ?? (v.processingRunId ? 'unavailable' : 'legacy_unknown'),
    v.provenance?.configurationHash, v.provenance?.hrvMetricId ?? 'unknown'].map(cell).join(','))
  return [header, ...rows].join('\n')
}
