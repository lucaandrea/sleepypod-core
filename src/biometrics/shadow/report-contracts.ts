import { z } from 'zod'
import { previewSummarySchema, referenceImportSchema, referenceMetricSchema } from '../references/contracts'
import { shadowReceiptEnvelopeSchema } from './receipt'
import { shadowMonitoringSchema } from './plan-contracts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const finite = z.number().finite()
const nullable = finite.nullable()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const score = z.object({ status: z.enum(['no_reference', 'compared', 'no_overlap', 'incompatible']),
  metrics: z.object({ mae: finite, medianAbsoluteError: finite, p95AbsoluteError: finite, signedBias: finite }).strict().nullable(),
  pairedCount: count, referenceCoverage: nullable, validObservationCount: count, unmatchedReferences: count, unmatchedObservations: count }).strict()
const support = z.object({ baseline: score, candidate: score }).strict()
const coverage = z.object({ usableCount: count, usableSlots: count, coverage: nullable }).strict()
const comparison = z.object({ version: z.literal('paired-numeric-support-v1'), metric: referenceMetricSchema,
  baseline: z.enum(['default', 'current', 'candidate']), candidate: z.enum(['default', 'current', 'candidate']), baselineHash: hash, candidateHash: hash,
  commonSupportScope: z.literal('all_configurations'), supportDefinition: z.literal('identical_unambiguous_observation_timestamps'),
  commonObservationCount: count, ownSupport: support, commonSupport: support,
  differences: z.object({ commonMae: nullable, commonMedianAbsoluteError: nullable, commonP95AbsoluteError: nullable,
    commonSignedBias: nullable, ownMae: nullable, referenceCoverage: nullable }).strict(),
  lostObservationTimestamps: count, addedObservationTimestamps: count,
  ambiguousObservationTimestamps: z.object({ baseline: count, candidate: count }).strict(), coverageReduced: z.boolean(),
  interpretation: z.literal('descriptive_numeric_agreement_not_validated_improvement'),
}).strict()
export const shadowReportRequestSchema = z.object({ id: z.string().uuid(), reference: referenceImportSchema.optional() }).strict()
export const shadowReportSchema = z.object({
  schema: z.literal('biometric-shadow-report-v1'), runId: z.string().uuid(), planHash: hash, snapshotHash: hash, reportHash: hash,
  capturedAtMs: count, state: z.enum(['pending', 'running', 'completed', 'stopped', 'failed']), reason: z.string().nullable(),
  health: z.enum(['issues_detected', 'waiting', 'within_observed_limits']), issues: z.array(z.string()),
  expectedSlots: count, observedSamples: count, maximumGapMs: count, attemptsObserved: count,
  alignment: shadowMonitoringSchema.shape.alignment,
  metrics: z.array(z.object({ metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1']), windowMs: count.nullable(),
    current: coverage, candidate: coverage, coverageDifference: nullable, issues: z.array(z.string()),
    referenceExclusions: z.record(z.string(), count), comparison }).strict()).max(3),
  pairing: z.object({ activeOnly: count, candidateOnly: count, unknownInputIdentity: count }).strict(),
  workerReceipt: shadowReceiptEnvelopeSchema.nullable(), executionPolicyHash: hash.nullable(),
  contextEvidence: z.literal('host_observations_not_live_processor_cache_attestation'), limitations: z.array(z.string()),
  referenceSummary: previewSummarySchema.nullable(), excludedBoundaryReferences: count,
  interpretation: z.literal('prospective_observation_and_reference_agreement_not_activation_authorization'),
}).strict()
