import { configHash } from '../../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../../algorithms/registry'
import { previewReferenceImport } from '../../../references/normalize'
const start = 1791673200000
const fixture = () => {
  const session = { id: 1, startMs: start, endMs: start + 600000, sleepDurationSeconds: 600, timesExitedBed: 0, presentIntervals: null, notPresentIntervals: null,
    vitals: Array.from({ length: 10 }, (_, id) => ({ id, timestampMs: start + id * 60000, heartRate: 60, hrv: 30, breathingRate: 14, processingRunId: null })), movement: [] }
  const dataset = { manifest: { splitProtocol: { assignments: [{ cohortId: 'night', sessionIds: [1, 2], split: 'tuning', startMs: start, endMs: start + 600000 }] } },
    snapshot: { version: 'processed-dataset-v1' as const, side: 'left' as const, subjectId: 'A', sessions: [session, { ...session, id: 2 }], processingRuns: [], references: [{
      importId: 'ref', revision: 1, contentHash: 'fixture', source: 'fixture', timePolicy: {}, measurements: previewReferenceImport({ side: 'left', subjectId: 'A', source: 'fixture', rows: [
        { recordKey: 'stage', metric: 'sleep_stages', value: 'light', unit: 'stage', startMs: start, endMs: start + 600000 },
        { recordKey: 'hr', metric: 'heart_rate', value: 62, unit: 'bpm', timestampMs: start },
      ] }).measurements,
    }] } }
  const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'stage_replay' as const, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
  return { dataset, job: { version: 'backtest-job-v1' as const, experimentId: '11111111-1111-4111-8111-111111111111', datasetId: '22222222-2222-4222-8222-222222222222',
    idempotencyKey: 'fixture', evaluatorBuildHash: 'f'.repeat(64), split: 'tuning' as const, configs: ['default', 'current'].map(label => ({ label: label as 'default' | 'current', revisionId: null, resolved: defaultConfig, resolvedHash: configHash(defaultConfig), manifestHash })),
    datasetHash: configHash(dataset), protocol, protocolHash: configHash(protocol), holdoutUse: 0, evidence: 'descriptive_only' as const } }
}
export { fixture as backtestFixture }

