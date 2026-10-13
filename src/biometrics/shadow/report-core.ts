import { compareNumericConfigurations } from '../backtest/numeric-comparison'
import { referenceCompatibility } from '../references/alignment'
import type { previewReferenceImport } from '../references/normalize'
import type { ShadowStore } from './store'

type Snapshot = ReturnType<ShadowStore['snapshot']>
export type ShadowReportSnapshot = Pick<Snapshot, 'samples' | 'capturedAtMs' | 'snapshotHash'> & {
  run: Pick<Snapshot['run'], 'id' | 'plan' | 'plan_hash' | 'state' | 'reason' | 'heartbeat_at_ms' | 'lease_until_ms' | 'workerReceipt'>
}
/** Pure report calculations shared by persisted production evidence and the
 * explicitly simulated browser demo. Storage integrity remains the caller's job. */
export function summarizeShadowSnapshot(snapshot: ShadowReportSnapshot, reference: ReturnType<typeof previewReferenceImport> | null, executionPolicyHash: string | null) {
  const { run, samples, capturedAtMs } = snapshot
  const { plan } = run, policy = plan.monitoring
  const until = Math.max(plan.startMs, Math.min(plan.endMs, capturedAtMs))
  const expectedSlots = capturedAtMs < plan.startMs
    ? 0
    : capturedAtMs < plan.endMs
      ? Math.floor((capturedAtMs - plan.startMs) / policy.expectedIntervalMs) + 1
      : Math.ceil((plan.endMs - plan.startMs) / policy.expectedIntervalMs)
  const windowSamples = samples.filter(sample => sample.timestampMs <= capturedAtMs && sample.timestampMs < plan.endMs)
  const clockSkew = samples.length !== windowSamples.length || (run.heartbeat_at_ms !== null && run.heartbeat_at_ms > capturedAtMs)
  let maximumGapMs = 0, previous = plan.startMs
  for (const sample of windowSamples) {
    maximumGapMs = Math.max(maximumGapMs, sample.timestampMs - previous)
    previous = sample.timestampMs
  }
  maximumGapMs = Math.max(maximumGapMs, until - previous)
  const measurements = reference?.measurements.filter(row => row.startMs >= plan.startMs && row.startMs < plan.endMs && row.endMs <= plan.endMs && row.endMs <= until) ?? []
  const metrics = plan.metrics.map((metric) => {
    const windowMs = metric === 'window_ibi_variability_v1' ? plan.windowIbiWindowMs ?? null : null
    const outputs = (['current', 'candidate'] as const).map((label) => {
      const slots = new Set<number>()
      const observations = windowSamples.map((sample) => {
        const row = sample.readings.find(row => row.metric === metric)
        if (!row) throw new Error('Missing shadow metric')
        const reading = label === 'current' ? row.active : row.candidate
        const value = reading.quality >= policy.minimumQuality ? reading.value : null
        if (value !== null) slots.add(Math.floor((sample.timestampMs - plan.startMs) / policy.expectedIntervalMs))
        return { timestampMs: sample.timestampMs, value }
      })
      return { label, configHash: label === 'current' ? plan.activeConfigHash : plan.candidateConfigHash, observations,
        usableCount: observations.filter(row => row.value !== null).length, usableSlots: slots.size,
        coverage: expectedSlots ? Math.min(1, slots.size / expectedSlots) : null }
    })
    const current = outputs[0], candidate = outputs[1]
    const coverageDifference = current.coverage === null || candidate.coverage === null ? null : candidate.coverage - current.coverage
    const issues = []
    if (candidate.coverage !== null && candidate.coverage < policy.minimumCandidateCoverage) issues.push('candidate_coverage_below_minimum')
    if (coverageDifference !== null && coverageDifference < -policy.maximumCoverageLoss) issues.push('coverage_regression')
    const exclusions: Record<string, number> = {}
    for (const row of measurements) {
      const reason = referenceCompatibility(metric, windowMs, row)
      if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1
    }
    return { metric, windowMs, current: { usableCount: current.usableCount, usableSlots: current.usableSlots, coverage: current.coverage },
      candidate: { usableCount: candidate.usableCount, usableSlots: candidate.usableSlots, coverage: candidate.coverage }, coverageDifference, issues,
      referenceExclusions: exclusions, comparison: compareNumericConfigurations(metric, windowMs, outputs, measurements, policy.alignment)[0] }
  })
  const issues: string[] = []
  if (run.workerReceipt?.schema === 'biometric-shadow-partial-receipt-v1' && !run.workerReceipt.receipt.cleanupConfirmed) issues.push('worker_cleanup_unconfirmed')
  if (clockSkew) issues.push('clock_skew')
  if (run.reason?.startsWith('join_')) issues.push('join_failed')
  if (run.reason === 'shadow_observation_window_missed') issues.push('observation_window_missed')
  else if (run.state === 'failed') issues.push('processor_failed')
  if (!issues.includes('worker_cleanup_unconfirmed') && (run.reason === 'shadow_lease_expired_cleanup_unconfirmed' || run.reason === 'shadow_worker_cleanup_unconfirmed')) issues.push('worker_cleanup_unconfirmed')
  if (run.reason === 'storage_quota') issues.push('storage_quota')
  if (run.state === 'running' && ((run.lease_until_ms ?? 0) <= capturedAtMs || run.heartbeat_at_ms === null
    || capturedAtMs - run.heartbeat_at_ms > policy.heartbeatStaleMs)) issues.push('worker_stale')
  if (maximumGapMs > policy.maximumGapMs) issues.push('observation_gap')
  if (!windowSamples.length && capturedAtMs >= plan.startMs) issues.push('no_observations')
  if (metrics.some(metric => metric.issues.length)) issues.push('coverage_degraded')
  const report = { schema: 'biometric-shadow-report-v1' as const, runId: run.id, planHash: run.plan_hash, snapshotHash: snapshot.snapshotHash,
    capturedAtMs, state: run.state, reason: run.reason, health: issues.length ? 'issues_detected' as const : capturedAtMs < plan.startMs ? 'waiting' as const : 'within_observed_limits' as const,
    issues, expectedSlots, observedSamples: windowSamples.length, maximumGapMs, alignment: policy.alignment,
    attemptsObserved: new Set(samples.map(sample => sample.attemptId)).size, metrics,
    pairing: { activeOnly: samples.filter(sample => sample.pairing?.activePresent && !sample.pairing.candidatePresent).length,
      candidateOnly: samples.filter(sample => sample.pairing?.candidatePresent && !sample.pairing.activePresent).length,
      unknownInputIdentity: samples.filter(sample => sample.inputHash === null).length },
    workerReceipt: run.workerReceipt,
    executionPolicyHash: executionPolicyHash,
    contextEvidence: 'host_observations_not_live_processor_cache_attestation' as const,
    limitations: [...new Set(samples.flatMap(sample => sample.candidateProvenance?.limitations ?? []))].sort(),
    referenceSummary: reference?.summary ?? null, excludedBoundaryReferences: reference ? reference.measurements.length - measurements.length : 0,
    interpretation: 'prospective_observation_and_reference_agreement_not_activation_authorization' as const }
  return report
}
