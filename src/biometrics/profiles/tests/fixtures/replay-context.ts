import { dataHash } from '../../../algorithms/canonical'
export function replayContextFixture(cohortIds: string[], configHashes: string[], pythonBuildHash: string, otherSideConfigHash: string) {
  const outputs = cohortIds.flatMap(cohortId => [...new Set(configHashes)].map(configHash => ({ cohortId, configHash,
    readings: [{ side: 'left' as const, timestampMs: 1000, heartRate: 60, hrvIndex: 30, hrvMetric: 'window_ibi_variability_v1' as const,
      breathingRate: 12, qualityScore: 1, flags: [], hrRaw: 60, sourceSide: 'left' as const, configHash, limitations: [] as string[] }],
    run: { version: 'retained-waveform-run-v1' as const, build_hash: pythonBuildHash, decoded_records: 1, raw_records: 1,
      counts: { records: 1, accepted_frames: 1, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: 1 },
      limitations: ['event_time_replaces_arrival_time'], config_hashes: { left: configHash, right: otherSideConfigHash }, artifact_hashes: ['d'.repeat(64)] },
  })))
  return { outputs, hash: dataHash(outputs) }
}
