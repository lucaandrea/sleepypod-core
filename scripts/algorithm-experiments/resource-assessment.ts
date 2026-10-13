import { z } from 'zod'
import { configHash } from '../../src/biometrics/algorithms/canonical'

const positive = z.number().finite().positive()
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const resourceLimitsSchema = z.object({ cpuMs: positive, wallMs: positive, memoryBytes: positive.int(), processes: positive.int(), outputBytes: positive.int() }).strict()
export const packageResourcePolicySchema = z.object({
  schema: z.literal('biometric-package-resource-policy-v1'),
  maximumWallMs: positive, maximumCpuMs: positive, maximumMemoryBytes: positive.int(), maximumProcesses: positive.int(),
  minimumSamples: positive.int(), maximumObservationGapMs: positive,
  evidenceMode: z.literal('sampled_counters_and_enforced_limits'),
}).strict()
const measurementSchema = z.object({
  schema: z.literal('biometric-package-resources-v1'), source: z.literal('host_docker_engine_stats'),
  attempts: count, samples: count, allAttemptsMeasured: z.boolean(),
  maximumObservedCpuMs: z.number().finite().nonnegative().nullable(), peakObservedMemoryBytes: positive.nullable(), maximumObservedProcesses: positive.int().nullable(),
  maximumObservationGapMs: z.number().finite().nonnegative(), elapsedMs: z.number().finite().nonnegative(),
  exactLifetimeCpu: z.literal(false), exactPeakMemory: z.literal(false), memoryIncludesCache: z.literal(true),
}).strict().refine(value => value.samples <= value.attempts
  && value.allAttemptsMeasured === (value.attempts > 0 && value.samples === value.attempts)
  && value.maximumObservationGapMs <= value.elapsedMs
  && (value.samples === 0
    ? value.maximumObservedCpuMs === null && value.peakObservedMemoryBytes === null && value.maximumObservedProcesses === null
    : value.maximumObservedCpuMs !== null && value.peakObservedMemoryBytes !== null && value.maximumObservedProcesses !== null), 'Inconsistent resource observations')

/** Assesses actual host evidence against explicit reviewed fixture criteria.
 * No default thresholds or implicit target-pod fitness claim. */
export function assessPackageResources(input: { measurements: unknown, limits: unknown, wallMs: unknown }, policyInput: unknown) {
  const policy = packageResourcePolicySchema.parse(policyInput)
  const policyHash = configHash(policy)
  const measurements = measurementSchema.safeParse(input.measurements)
  const limits = resourceLimitsSchema.safeParse(input.limits)
  const wall = z.number().finite().nonnegative().safeParse(input.wallMs)
  if (!measurements.success || !limits.success || !wall.success) return { status: 'insufficient_evidence' as const, policyHash, failures: ['invalid_or_missing_resource_evidence'] }
  const evidence = measurements.data
  const failures: string[] = [], missing: string[] = []
  if (!evidence.allAttemptsMeasured) missing.push('unmeasured_attempts')
  if (evidence.samples < policy.minimumSamples) missing.push('insufficient_samples')
  if (evidence.maximumObservationGapMs > policy.maximumObservationGapMs) missing.push('observation_gap')
  if (wall.data > policy.maximumWallMs) failures.push('wall_budget_exceeded')
  if (evidence.maximumObservedCpuMs !== null && evidence.maximumObservedCpuMs > policy.maximumCpuMs) failures.push('cpu_budget_exceeded')
  if (evidence.peakObservedMemoryBytes !== null && evidence.peakObservedMemoryBytes > policy.maximumMemoryBytes) failures.push('memory_budget_exceeded')
  if (evidence.maximumObservedProcesses !== null && evidence.maximumObservedProcesses > policy.maximumProcesses) failures.push('process_budget_exceeded')
  if (limits.data.cpuMs > policy.maximumCpuMs || limits.data.wallMs > policy.maximumWallMs
    || limits.data.memoryBytes > policy.maximumMemoryBytes || limits.data.processes > policy.maximumProcesses) failures.push('enforced_limits_exceed_policy')
  return { status: failures.length ? 'failed' as const : missing.length ? 'insufficient_evidence' as const : 'within_observed_limits' as const,
    policyHash, failures, missing }
}
