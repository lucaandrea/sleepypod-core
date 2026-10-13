// Synthetic test criteria only; not target-pod qualification.
export const fixtureResourceTestPolicy = { schema: 'biometric-package-resource-policy-v1', maximumWallMs: 5000, maximumCpuMs: 5000,
  maximumMemoryBytes: 64 * 1024 * 1024, maximumProcesses: 1, minimumSamples: 1, maximumObservationGapMs: 5000, evidenceMode: 'sampled_counters_and_enforced_limits' }
