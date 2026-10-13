import { z } from 'zod'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { verifyAlgorithmPackage } from '../../src/biometrics/packages/manifest'
import { checkPackageDeterminism } from './determinism'
import { packageFixtureSuiteSchema, runPackageFixtures } from './fixtures'
import { assessPackageResources } from './resource-assessment'
import type { executePackageExperiment } from './container'

export const packagePreflightPlanSchema = z.object({ schema: z.literal('biometric-package-preflight-plan-v1'),
  suiteHash: z.string().regex(/^[a-f0-9]{64}$/), repetitions: z.number().int().min(2).max(5),
  configHash: z.string().regex(/^[a-f0-9]{64}$/), hardwareId: z.string().min(1).max(100),
  sampleRateHz: z.number().int().positive(), side: z.enum(['left', 'right']),
}).strict()

/** Execute all evidence in one host-controlled flow. Every fixture is replayed
 * independently for determinism, with the same candidate configuration/seed.
 * This does not establish pod compatibility, holdout accuracy or installation. */
export async function runPackagePreflight(options: Pick<Parameters<typeof executePackageExperiment>[0], 'manifest' | 'files' | 'policy' | 'signal'>,
  rawPlan: unknown, rawSuite: unknown) {
  const plan = packagePreflightPlanSchema.parse(structuredClone(rawPlan))
  const suite = packageFixtureSuiteSchema.parse(structuredClone(rawSuite))
  if (dataHash(suite) !== plan.suiteHash) throw new Error('Preflight suite identity mismatch')
  const files = new Map([...options.files].map(([path, bytes]) => [path, Buffer.from(bytes)]))
  const verified = verifyAlgorithmPackage(options.manifest, files)
  const stable = { manifest: verified.manifest, files, policy: structuredClone(options.policy), signal: options.signal }
  for (const fixture of suite.fixtures) {
    if (fixture.request.packageHash !== verified.packageHash
      || configHash({ config: fixture.request.config, seed: fixture.request.seed }) !== plan.configHash
      || fixture.request.hardwareId !== plan.hardwareId || fixture.request.sampleRateHz !== plan.sampleRateHz
      || fixture.request.side !== plan.side) throw new Error('Preflight fixture configuration mismatch')
  }
  options.signal?.throwIfAborted()
  const fixtureReport = await runPackageFixtures(stable, suite)
  const determinism = []
  for (const fixture of suite.fixtures) {
    options.signal?.throwIfAborted()
    try {
      const report = await checkPackageDeterminism({ ...stable, request: fixture.request, frames: () => fixture.frames }, plan.repetitions)
      determinism.push({ fixtureId: fixture.id, report, resources: report.runs.map(run => assessPackageResources(run.execution, suite.resourcePolicy)), error: null })
    }
    catch (error) {
      options.signal?.throwIfAborted()
      determinism.push({ fixtureId: fixture.id, report: null, resources: [], error: error instanceof Error ? error.message.slice(0, 1000) : 'Determinism execution failed' })
    }
  }
  const failed = fixtureReport.status === 'failed' || determinism.some(row => !row.report?.deterministic || row.resources.some(resource => resource.status === 'failed'))
  const incomplete = fixtureReport.status === 'incomplete' || determinism.some(row => row.resources.some(resource => resource.status !== 'within_observed_limits'))
  return { schema: 'biometric-package-preflight-report-v1' as const, packageHash: verified.packageHash, manifest: verified.manifest, image: stable.policy.image,
    plan, planHash: configHash(plan), fixtureReport, determinism,
    status: failed ? 'failed' as const : incomplete ? 'incomplete' as const : 'external_checks_passed' as const,
    interpretation: 'requires_heldout_accuracy_target_pod_compatibility_and_reviewed_release' as const }
}
