import { z } from 'zod'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { algorithmPackageManifestSchema } from '../../src/biometrics/packages/manifest'
import { PackageFrameValidator } from '../../src/biometrics/packages/protocol'
import { packageComparisonInputSchema } from './comparison'
import { assessFixtureReadings, fixtureCategories, packageFixtureSuiteSchema } from './fixtures'
import { packageInputHash } from './input'
import { packagePreflightPlanSchema } from './preflight'
import { assessPackageResources } from './resource-assessment'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const execution = z.object({ image: z.string(), limits: z.unknown(), measurements: z.unknown(), wallMs: z.unknown() }).passthrough()
const result = packageComparisonInputSchema.shape.outputs.element.shape.result.extend({ execution }).passthrough()
const reportSchema = z.object({ schema: z.literal('biometric-package-preflight-report-v1'), packageHash: hash, manifest: algorithmPackageManifestSchema,
  image: z.string(), plan: packagePreflightPlanSchema, planHash: hash,
  fixtureReport: z.object({ schema: z.literal('biometric-package-fixture-report-v1'), packageHash: hash, suiteHash: hash,
    suite: packageFixtureSuiteSchema, status: z.enum(['failed', 'incomplete', 'fixture_checks_passed']), missingCategories: z.array(z.string()),
    results: z.array(z.object({ fixtureId: z.string(), category: z.string(), fixtureHash: hash, assessment: z.unknown(),
      resourceAssessment: z.unknown(), execution: result.nullable(), error: z.string().nullable() }).strict()).min(1).max(64),
    promotion: z.literal('requires_determinism_resource_holdout_compatibility_and_release_review'),
  }).strict(),
  determinism: z.array(z.object({ fixtureId: z.string(), resources: z.array(z.unknown()), error: z.string().nullable(),
    report: z.object({ schema: z.literal('biometric-package-determinism-v1'), deterministic: z.boolean(),
      runs: z.array(z.object({ packageHash: hash, runHash: hash, input: result.shape.frozenInput, outputHash: hash,
        responseCount: z.number().int().positive(), execution }).strict()).min(2).max(5),
      qualification: z.literal('requires_resource_noise_holdout_compatibility_checks_and_review'),
    }).strict().nullable(),
  }).strict()).min(1).max(64),
  status: z.enum(['failed', 'incomplete', 'external_checks_passed']),
  interpretation: z.literal('requires_heldout_accuracy_target_pod_compatibility_and_reviewed_release'),
}).strict()
function same(actual: unknown, expected: unknown) {
  if (dataHash(actual) !== dataHash(expected)) throw new Error('Retained preflight integrity mismatch')
}
/** Recompute derived preflight status and verify fixture/run identities. Host
 * receipts remain trusted execution records, not candidate attestations. */
export function verifyPreflightEvidence(raw: unknown, expected: { plan: unknown, packageHash: string, image: string }) {
  const report = reportSchema.parse(raw), suite = report.fixtureReport.suite
  same(report.plan, expected.plan)
  if (report.packageHash !== expected.packageHash || configHash(report.manifest) !== expected.packageHash || report.image !== expected.image
    || report.planHash !== configHash(report.plan) || dataHash(suite) !== report.plan.suiteHash
    || report.fixtureReport.suiteHash !== report.plan.suiteHash || report.fixtureReport.packageHash !== expected.packageHash) throw new Error('Retained preflight identity mismatch')
  if (report.fixtureReport.results.length !== suite.fixtures.length || report.determinism.length !== suite.fixtures.length
    || new Set(report.fixtureReport.results.map(row => row.fixtureId)).size !== suite.fixtures.length
    || new Set(report.determinism.map(row => row.fixtureId)).size !== suite.fixtures.length) throw new Error('Retained preflight fixture set mismatch')
  const checkExecution = (value: z.infer<typeof execution>) => {
    if (value.image !== expected.image) throw new Error('Retained preflight image mismatch')
    same(value.limits, report.manifest.resources)
    return assessPackageResources(value, suite.resourcePolicy)
  }
  const fixtures = suite.fixtures.map((fixture) => {
    const row = report.fixtureReport.results.find(row => row.fixtureId === fixture.id)
    const repeated = report.determinism.find(row => row.fixtureId === fixture.id)
    if (!row || !repeated || row.fixtureHash !== dataHash(fixture) || row.category !== fixture.category
      || fixture.request.packageHash !== expected.packageHash || fixture.request.inputHash !== packageInputHash(fixture.frames)
      || configHash({ config: fixture.request.config, seed: fixture.request.seed }) !== report.plan.configHash
      || fixture.request.hardwareId !== report.plan.hardwareId || fixture.request.sampleRateHz !== report.plan.sampleRateHz
      || fixture.request.side !== report.plan.side) throw new Error('Retained preflight fixture identity mismatch')
    const runHash = configHash(fixture.request)
    if (row.execution) {
      if (row.error !== null || row.execution.runHash !== runHash || row.execution.packageHash !== expected.packageHash
        || row.execution.frozenInput.hash !== fixture.request.inputHash || row.execution.frozenInput.frameCount !== fixture.frames.length
        || row.execution.results.length !== fixture.frames.length) throw new Error('Retained preflight run identity mismatch')
      const validator = new PackageFrameValidator(report.manifest, fixture.request)
      fixture.frames.forEach((frame, index) => validator.validateStep(frame, row.execution?.results[index]))
      same(row.assessment, assessFixtureReadings(fixture.expectations, row.execution.results.flatMap(frame => frame.readings)))
      same(row.resourceAssessment, checkExecution(row.execution.execution))
    }
    else {
      if (row.error === null) throw new Error('Missing preflight execution failure')
      same(row.assessment, { passed: false, failures: ['execution_failed'], usableReadings: [] })
      same(row.resourceAssessment, null)
    }
    if (repeated.report) {
      if (repeated.error !== null || repeated.report.runs.length !== report.plan.repetitions) throw new Error('Retained repetition count mismatch')
      for (const run of repeated.report.runs) {
        if (run.runHash !== runHash || run.packageHash !== expected.packageHash || run.input.hash !== fixture.request.inputHash
          || run.input.frameCount !== fixture.frames.length || run.responseCount !== fixture.frames.length) throw new Error('Retained determinism identity mismatch')
      }
      same(repeated.resources, repeated.report.runs.map(run => checkExecution(run.execution)))
      same(repeated.report.deterministic, repeated.report.runs.every(run => run.outputHash === repeated.report?.runs[0].outputHash))
    }
    else {
      if (repeated.error === null) throw new Error('Missing determinism execution failure')
      same(repeated.resources, [])
    }
    return { fixturePassed: row.execution !== null && assessFixtureReadings(fixture.expectations, row.execution.results.flatMap(frame => frame.readings)).passed,
      resource: row.execution ? checkExecution(row.execution.execution).status : null,
      deterministic: repeated.report?.deterministic ?? false,
      repeatResources: repeated.report?.runs.map(run => checkExecution(run.execution).status) ?? [] }
  })
  const missingCategories = fixtureCategories.filter(category => !suite.fixtures.some(fixture => fixture.category === category))
  same(report.fixtureReport.missingCategories, missingCategories)
  const fixtureStatus = fixtures.some(row => !row.fixturePassed || row.resource === 'failed')
    ? 'failed'
    : missingCategories.length || fixtures.some(row => row.resource !== 'within_observed_limits') ? 'incomplete' : 'fixture_checks_passed'
  same(report.fixtureReport.status, fixtureStatus)
  const status = fixtureStatus === 'failed' || fixtures.some(row => !row.deterministic || row.repeatResources.includes('failed'))
    ? 'failed'
    : fixtureStatus === 'incomplete' || fixtures.some(row => row.repeatResources.some(status => status !== 'within_observed_limits')) ? 'incomplete' : 'external_checks_passed'
  same(report.status, status)
  return { status, planHash: report.planHash, packageHash: report.packageHash, image: report.image }
}
