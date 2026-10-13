import { z } from 'zod'
import { dataHash } from '../../src/biometrics/algorithms/canonical'
import { packageRunRequestSchema, signalFrameSchema } from '../../src/biometrics/packages/protocol'
import { verifyAlgorithmPackage } from '../../src/biometrics/packages/manifest'
import { assessPackageResources, packageResourcePolicySchema } from './resource-assessment'
import { packageInputHash } from './input'
import { executePackageExperiment } from './container'

const time = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
const common = { metric: z.string().min(1).max(100), startMs: time, endMs: time }
const expectationSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('numeric'), minimum: z.number().finite(), maximum: z.number().finite(),
    minimumReadings: z.number().int().positive().max(20000), minimumQuality: z.number().min(0).max(1) }).strict(),
  z.object({ ...common, kind: z.literal('abstain') }).strict(),
])
export const fixtureCategories = ['clean_signal', 'pump', 'empty_bed', 'motion', 'cross_side', 'harmonics', 'gaps', 'warmup', 'boundary_reset'] as const
const fixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/), category: z.enum(fixtureCategories),
  request: packageRunRequestSchema, frames: z.array(signalFrameSchema).min(1).max(256),
  expectations: z.array(expectationSchema).min(1).max(256),
}).strict().superRefine((fixture, context) => {
  if (!fixture.frames.length) return
  const firstMs = fixture.frames[0].timestampMs
  const last = fixture.frames[fixture.frames.length - 1]
  const endMs = last.timestampMs + (last.samples[fixture.request.side]?.length ?? 0) * 1000 / fixture.request.sampleRateHz
  if (fixture.category === 'clean_signal' && !fixture.expectations.some(expected => expected.kind === 'numeric')) context.addIssue({ code: 'custom', message: 'Clean-signal fixture requires numeric coverage' })
  if (fixture.category === 'empty_bed' && fixture.expectations.some(expected => expected.kind !== 'abstain')) context.addIssue({ code: 'custom', message: 'Empty-bed fixture must require abstention' })
  for (let index = 0; index < fixture.expectations.length; index++) {
    const expected = fixture.expectations[index]
    if (expected.startMs < firstMs || expected.endMs > endMs) context.addIssue({ code: 'custom', message: 'Expectation outside fixture input interval' })
    if (expected.startMs >= expected.endMs || (expected.kind === 'numeric' && expected.minimum > expected.maximum)) {
      context.addIssue({ code: 'custom', message: 'Invalid fixture expectation range' })
    }
    if (fixture.expectations.slice(0, index).some(other => other.metric === expected.metric && other.startMs < expected.endMs && expected.startMs < other.endMs)) {
      context.addIssue({ code: 'custom', message: 'Overlapping fixture expectations' })
    }
  }
})
export const packageFixtureSuiteSchema = z.object({ schema: z.literal('biometric-package-fixtures-v1'), resourcePolicy: packageResourcePolicySchema,
  fixtures: z.array(fixtureSchema).min(1).max(64),
}).strict().refine(suite => new Set(suite.fixtures.map(fixture => fixture.id)).size === suite.fixtures.length, 'Duplicate fixture identity')

type Expectation = z.infer<typeof expectationSchema>
type Reading = Awaited<ReturnType<typeof executePackageExperiment>>['results'][number]['readings'][number]
/** Expectations come from reviewed fixtures, never from package responses.
 * Every returned reading must belong to a declared expectation window. */
export function assessFixtureReadings(expectations: Expectation[], readings: Reading[]) {
  const failures: string[] = []
  const counts = expectations.map(() => 0)
  const identities = new Set<string>()
  for (const reading of readings) {
    const identity = `${reading.metric}:${reading.timestampMs}`
    if (identities.has(identity)) failures.push(`duplicate_reading:${identity}`)
    identities.add(identity)
    const index = expectations.findIndex(expected => expected.metric === reading.metric && expected.startMs <= reading.timestampMs && reading.timestampMs < expected.endMs)
    if (index < 0) {
      failures.push(`unexpected_reading:${identity}`)
      continue
    }
    const expected = expectations[index]
    if (expected.kind === 'abstain') {
      if (reading.value !== null) failures.push(`failed_abstention:${identity}`)
    }
    else if (reading.value !== null) {
      if (reading.value < expected.minimum || reading.value > expected.maximum || reading.quality < expected.minimumQuality) failures.push(`out_of_range_or_low_quality:${identity}`)
      else counts[index]++
    }
  }
  expectations.forEach((expected, index) => {
    if (expected.kind === 'numeric' && counts[index] < expected.minimumReadings) failures.push(`insufficient_coverage:${expected.metric}:${index}`)
  })
  return { passed: failures.length === 0, failures, usableReadings: counts }
}

/** This is one qualification dimension, not a held-out improvement claim.
 * Fresh containers also prevent state leaking between independent fixtures. */
export async function runPackageFixtures(options: Pick<Parameters<typeof executePackageExperiment>[0], 'manifest' | 'files' | 'policy' | 'signal'>, suiteInput: unknown) {
  const suite = packageFixtureSuiteSchema.parse(structuredClone(suiteInput))
  const suiteHash = dataHash(suite)
  const verified = verifyAlgorithmPackage(options.manifest, options.files)
  const stable = { manifest: verified.manifest, files: new Map([...options.files].map(([path, bytes]) => [path, Buffer.from(bytes)])), policy: structuredClone(options.policy), signal: options.signal }
  for (const fixture of suite.fixtures) {
    for (const expected of fixture.expectations) {
      if (!verified.manifest.metrics.some(metric => metric.id === expected.metric)) throw new Error('Fixture expects an undeclared metric')
    }
    if (fixture.request.packageHash !== verified.packageHash || fixture.request.inputHash !== packageInputHash(fixture.frames)) throw new Error('Fixture input/package identity mismatch')
  }
  const results = []
  for (const fixture of suite.fixtures) {
    options.signal?.throwIfAborted()
    const identity = { fixtureId: fixture.id, category: fixture.category, fixtureHash: dataHash(fixture) }
    try {
      const execution = await executePackageExperiment({ ...stable, request: fixture.request, frames: fixture.frames })
      const assessment = assessFixtureReadings(fixture.expectations, execution.results.flatMap(frame => frame.readings))
      results.push({ ...identity, assessment, resourceAssessment: assessPackageResources(execution.execution, suite.resourcePolicy), execution, error: null })
    }
    catch (error) {
      options.signal?.throwIfAborted()
      results.push({ ...identity, assessment: { passed: false, failures: ['execution_failed'], usableReadings: [] }, resourceAssessment: null, execution: null,
        error: error instanceof Error ? error.message.slice(0, 1000) : 'Experiment failed' })
    }
  }
  const covered = new Set(suite.fixtures.map(fixture => fixture.category))
  const missingCategories = fixtureCategories.filter(category => !covered.has(category))
  return { schema: 'biometric-package-fixture-report-v1' as const, packageHash: verified.packageHash, suiteHash, suite,
    status: results.some(result => !result.assessment.passed || result.resourceAssessment?.status === 'failed')
      ? 'failed'
      : missingCategories.length || results.some(result => result.resourceAssessment?.status !== 'within_observed_limits') ? 'incomplete' : 'fixture_checks_passed',
    missingCategories, results, promotion: 'requires_determinism_resource_holdout_compatibility_and_release_review' as const }
}
