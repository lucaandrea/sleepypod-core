import { recoverExperimentStaging } from './staging-recovery'
import { runPackagePreflight } from './preflight'
import { recoverExpiredContainers } from './recovery'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runManagedFiles } from './managed-files'
import { experimentPolicySchema as policySchema } from './policy'
import { comparePackageOutputs } from './comparison'
import { runPackageFixtures } from './fixtures'
import { packageInputHash } from './input'
import { inspectPythonEnvironment } from './environment'
import { executePackageExperiment } from './container'
import { checkPackageDeterminism } from './determinism'
import { publishJson, readJsonFile, readJsonLines, readPackageProposal } from './files'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const usage = 'Usage: preflight PROPOSAL PLAN SUITE POLICY OUTPUT | recover OUTPUT | managed WORKSPACE DESCRIPTOR RECEIPT [STORAGE_POLICY] | compare INPUT OUTPUT | fixtures PROPOSAL SUITE POLICY OUTPUT | lock IMAGE OUTPUT | input-hash FRAMES MAX_BYTES OUTPUT | inspect PROPOSAL OUTPUT | run PROPOSAL REQUEST FRAMES POLICY OUTPUT | determinism PROPOSAL REQUEST FRAMES POLICY REPETITIONS OUTPUT'

export async function runExperimentCli(args: string[]) {
  const [command, ...paths] = args
  if (command === 'preflight' && paths.length === 5) {
    const proposal = readPackageProposal(paths[0])
    const plan = readJsonFile(paths[1], 16384)
    const suite = readJsonFile(paths[2], 32 * 1024 * 1024)
    const policy = policySchema.parse(readJsonFile(paths[3], 16384))
    await publishJson(paths[4], await runPackagePreflight({ ...proposal, policy }, plan, suite))
    return
  }
  if (command === 'recover' && paths.length === 1) {
    const containers = await recoverExpiredContainers()
    const staging = await recoverExperimentStaging()
    await publishJson(paths[0], { schema: 'biometric-experiment-recovery-v1', containers, staging })
    return
  }
  if (command === 'managed' && (paths.length === 3 || paths.length === 4)) {
    await publishJson(paths[2], await runManagedFiles(paths[0], paths[1], paths[3] ? readJsonFile(paths[3], 16384) : undefined))
    return
  }
  if (command === 'compare' && paths.length === 2) {
    await publishJson(paths[1], comparePackageOutputs(readJsonFile(paths[0], 32 * 1024 * 1024)))
    return
  }
  if (command === 'fixtures' && paths.length === 4) {
    const proposal = readPackageProposal(paths[0])
    const suite = readJsonFile(paths[1], 32 * 1024 * 1024)
    const policy = policySchema.parse(readJsonFile(paths[2], 16384))
    const report = await runPackageFixtures({ manifest: proposal.manifest, files: proposal.files, policy }, suite)
    await publishJson(paths[3], report)
    return
  }
  if (command === 'lock' && paths.length === 2) {
    await publishJson(paths[1], await inspectPythonEnvironment(paths[0]))
    return
  }
  if (command === 'input-hash' && paths.length === 3) {
    const maximumBytes = positive.parse(Number(paths[1]))
    const hash = packageInputHash(readJsonLines(paths[0], maximumBytes))
    await publishJson(paths[2], { schema: 'biometric-package-input-v1', hash })
    return
  }
  if (command === 'inspect' && paths.length === 2) {
    const proposal = readPackageProposal(paths[0])
    await publishJson(paths[1], { schema: 'biometric-package-intake-v1', packageHash: proposal.packageHash,
      status: proposal.status, manifest: proposal.manifest, totalBytes: proposal.totalBytes })
    return
  }
  if ((command === 'run' && paths.length === 5) || (command === 'determinism' && paths.length === 6)) {
    const policy = policySchema.parse(readJsonFile(paths[3], 16384))
    const proposal = readPackageProposal(paths[0])
    const request = readJsonFile(paths[1], 65536)
    const frames = () => readJsonLines(paths[2], policy.maximumInputBytes)
    const options = { manifest: proposal.manifest, files: proposal.files, request, policy }
    const report = command === 'run'
      ? { schema: 'biometric-package-experiment-v1', status: 'experiment_only', ...await executePackageExperiment({ ...options, frames: frames() }) }
      : await checkPackageDeterminism({ ...options, frames }, Number(paths[4]))
    await publishJson(paths[paths.length - 1], report)
    return
  }
  throw new Error(usage)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExperimentCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
