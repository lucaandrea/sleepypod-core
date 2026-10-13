import { createHash } from 'node:crypto'
import { canonicalJson } from '../../src/biometrics/algorithms/canonical'
import { verifyAlgorithmPackage } from '../../src/biometrics/packages/manifest'
import { executePackageExperiment } from './container'

type ExperimentOptions = Parameters<typeof executePackageExperiment>[0]
/** Independent containers provide a fresh process and filesystem for every run.
 * The trusted caller supplies a fresh iterator over the same retained inputs. */
export async function checkPackageDeterminism(options: Omit<ExperimentOptions, 'frames'> & {
  frames: () => Iterable<unknown>
}, repetitions = 2) {
  if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 5) throw new Error('Determinism requires 2–5 independent runs')
  verifyAlgorithmPackage(options.manifest, options.files)
  const stable = { manifest: structuredClone(options.manifest), request: structuredClone(options.request),
    policy: structuredClone(options.policy), signal: options.signal, files: new Map([...options.files].map(([path, bytes]) => [path, Buffer.from(bytes)])) }
  type Result = Awaited<ReturnType<typeof executePackageExperiment>>
  const runs: (Pick<Result, 'packageHash' | 'runHash' | 'execution'> & { input: Result['frozenInput'], outputHash: string, responseCount: number })[] = []
  for (let index = 0; index < repetitions; index++) {
    const result = await executePackageExperiment({ ...stable, frames: options.frames() })
    const hash = createHash('sha256').update('biometric-package-output-v1\n')
    for (const frame of result.results) hash.update(canonicalJson(frame) + '\n')
    runs.push({ packageHash: result.packageHash, runHash: result.runHash, input: result.frozenInput,
      outputHash: hash.digest('hex'), responseCount: result.results.length, execution: result.execution })
  }
  const deterministic = runs.every(run => run.runHash === runs[0].runHash && run.outputHash === runs[0].outputHash)
  return { schema: 'biometric-package-determinism-v1' as const, deterministic, runs,
    qualification: 'requires_resource_noise_holdout_compatibility_checks_and_review' as const }
}
