import { dataHash } from '../../../algorithms/canonical'
import { submitShadowSchema } from '../../submission-contracts'
export const submissionTime = 1700000000000
export const submissionEntry = { qualificationId: 'synthetic-test-only' }
export function submissionFixture() {
  const hash = 'a'.repeat(64)
  return submitShadowSchema.parse({ idempotencyKey: 'submit', plan: {
    schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'fixture', candidateRevisionId: null,
    expectedBindings: { left: { generation: 1, resolvedHash: hash }, right: { generation: 2, resolvedHash: hash } },
    execution: { version: 'shadow-execution-policy-v1', configHashes: { left: hash, right: hash },
      maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
      budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 10000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
      leaseMs: 1500, heartbeatMs: 200, sources: { pollMs: 50, maximumActiveRows: 10, databaseBusyTimeoutMs: 50,
        frames: { maximumFrames: 10, maximumBytes: 100000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
        context: { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 4096 } } },
    startMs: submissionTime + 1000, endMs: submissionTime + 10000, candidateConfigHash: hash, activeConfigHash: hash,
    engineBuildHash: hash, qualificationHash: dataHash(submissionEntry), maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 100, drainGraceMs: 500 },
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 1000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } },
  } })
}
