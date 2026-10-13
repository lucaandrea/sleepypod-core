import { recoveryLabelArguments } from './recovery'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import { configHash } from '../../src/biometrics/algorithms/canonical'

const exec = promisify(execFile)
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const pythonEnvironmentLockSchema = z.object({
  schema: z.literal('biometric-python-environment-v1'), image: imageId,
  implementation: z.literal('cpython'), pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  system: z.literal('Linux'), machine: z.string().regex(/^[a-zA-Z0-9_+-]{1,40}$/),
  distributions: z.array(z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), version: z.string().min(1).max(100) }).strict()).max(512),
}).strict().superRefine((value, context) => {
  const names = value.distributions.map(item => item.name)
  if (names.some((name, index) => index > 0 && name <= names[index - 1])) context.addIssue({ code: 'custom', message: 'Distributions must be unique and sorted by normalized name' })
})

const probe = `import importlib.metadata, json, platform, re, sys
packages = sorted([{'name': re.sub(r'[-_.]+', '-', dist.metadata['Name']).lower(), 'version': dist.version} for dist in importlib.metadata.distributions()], key=lambda item: item['name'])
print(json.dumps({'implementation': sys.implementation.name, 'pythonVersion': platform.python_version(), 'system': platform.system(), 'machine': platform.machine(), 'distributions': packages}))
`

/** Probe an operator-reviewed immutable image, with no candidate code or mounts.
 * Captures installed versions and pins all runtime bytes through the image ID.
 * This is not a dependency resolver or an approval of the image's contents. */
export async function inspectPythonEnvironment(image: string) {
  imageId.parse(image)
  const name = `sleepypod-environment-${randomUUID()}`
  try {
    await exec('docker', ['create', '--name', name, ...recoveryLabelArguments('environment', 10000), '--network', 'none', '--ipc', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--user', '65534:65534',
      '--pids-limit', '16', '--memory', '134217728', '--memory-swap', '134217728', '--cpus', '1',
      '--ulimit', 'core=0', '--ulimit', 'cpu=5', '--log-driver', 'none', '--restart', 'no', '--no-healthcheck',
      '--entrypoint', 'python', image, '-I', '-B', '-c', probe], { timeout: 10000, maxBuffer: 65536 })
    const { stdout } = await exec('docker', ['start', '-a', name], { timeout: 10000, maxBuffer: 256 * 1024 })
    return pythonEnvironmentLockSchema.parse({ ...JSON.parse(stdout), schema: 'biometric-python-environment-v1', image })
  }
  finally {
    await removeProbe(name)
  }
}
async function removeProbe(name: string) {
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 10000, maxBuffer: 65536 })
  }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No such container:')) throw error
  }
}

export function parsePythonEnvironmentLock(bytes: Uint8Array, image: string) {
  if (bytes.byteLength > 256 * 1024) throw new Error('Environment lock byte limit exceeded')
  const lock = pythonEnvironmentLockSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (lock.image !== image) throw new Error('Environment lock does not match operator image')
  return lock
}
export function matchPythonEnvironment(bytes: Uint8Array, actual: unknown, image: string) {
  const locked = parsePythonEnvironmentLock(bytes, image)
  const observed = pythonEnvironmentLockSchema.parse(actual)
  if (configHash(locked) !== configHash(observed)) throw new Error('Installed Python environment differs from dependency lock')
  return { schema: 'biometric-python-environment-verification-v1' as const, image,
    lockHash: createHash('sha256').update(bytes).digest('hex'), environmentHash: configHash(observed) }
}
