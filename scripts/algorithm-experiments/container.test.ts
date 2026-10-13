// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runExperimentCli } from './cli'
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { packageFixture } from '../../src/biometrics/packages/tests/fixture'
import { inspectPythonEnvironment } from './environment'
import { checkPackageDeterminism } from './determinism'
import { packageInputHash } from './input'
import { executePackageExperiment } from './container'

const image = process.env.BIOMETRIC_EXPERIMENT_TEST_IMAGE
let lockBytes: Buffer<ArrayBuffer>
beforeAll(async () => {
  if (image) lockBytes = Buffer.from(JSON.stringify(await inspectPythonEnvironment(image)))
})
const program = `import json, sys
init = json.loads(sys.stdin.readline())
for line in sys.stdin:
    message = json.loads(line)
    frame = message['frame']
    print(json.dumps({'schema': 'biometric-metric-frame-v1', 'runHash': init['runHash'], 'frameHash': message['frameHash'], 'sequence': frame['sequence'], 'readings': [], 'state': {}}), flush=True)
`
function options(code: string) {
  const { manifest, files } = packageFixture()
  files.set('engine.py', Buffer.from(code))
  files.set(manifest.dependencyLock, lockBytes)
  manifest.artifacts = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
  manifest.resources = { cpuMs: 5000, wallMs: 5000, memoryBytes: 64 * 1024 * 1024, processes: 1, outputBytes: 16384 }
  const frames = [{ schema: 'biometric-signal-frame-v1', sequence: 0, timestampMs: 1000, samples: { left: [1, 2, 3], right: null }, context: { occupied: null, pumpActive: null } }]
  frames.push({ ...frames[0], sequence: 1, timestampMs: 1006 })
  return { manifest, files,
    request: { schema: 'biometric-package-run-v1', packageHash: configHash(manifest), inputHash: packageInputHash(frames), hardwareId: 'pod4', sampleRateHz: 500, side: 'left', seed: 123, config: {} },
    frames,
    policy: { image: image ?? '', maximumWallMs: 10000, maximumMemoryBytes: 128 * 1024 * 1024, maximumProcesses: 4, maximumOutputBytes: 32768, maximumInputBytes: 32768 } }
}

describe.skipIf(!image)('real external Docker experiments', () => {
  it('runs the frame protocol with read-only input, no network, no extra processes or host environment', async () => {
    const probes = `import os, socket
assert os.getuid() == 65534
assert 'BIOMETRIC_EXPERIMENT_TEST_IMAGE' not in os.environ
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists('/root/.ssh')
for path in ['/package/engine.py', '/tmp/write-attempt']:
    try:
        open(path, 'w')
    except OSError:
        pass
    else:
        raise AssertionError('Writable filesystem')
try:
    os.fork()
except OSError:
    pass
else:
    raise AssertionError('Fork succeeded')
s = socket.socket()
s.settimeout(0.2)
try:
    s.connect(('1.1.1.1', 443))
except OSError:
    pass
else:
    raise AssertionError('Network available')
s.close()
`
    const input = options(probes + program)
    const execution = executePackageExperiment(input)
    input.policy.image = 'sha256:' + 'b'.repeat(64)
    const result = await execution
    expect(result.execution.environment.image).toBe(image)
    expect(result.results).toHaveLength(2)
    expect(result.execution.isolation).toBe('docker-restricted-v1')
  }, 20000)
  it('runs a complete file-based CLI experiment and publishes a reviewable report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-cli-test-'))
    try {
      const input = options(program)
      const proposal = { schema: 'biometric-package-proposal-v1', manifest: input.manifest,
        files: [...input.files].map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })) }
      for (const [name, value] of [['proposal', proposal], ['request', input.request], ['policy', input.policy]] as const) {
        await writeFile(join(root, name), JSON.stringify(value))
      }
      await writeFile(join(root, 'frames'), input.frames.map(frame => JSON.stringify(frame)).join('\n') + '\n')
      await runExperimentCli(['run', ...['proposal', 'request', 'frames', 'policy', 'report'].map(name => join(root, name))])
      const report = JSON.parse(await readFile(join(root, 'report'), 'utf8'))
      expect(report).toMatchObject({ schema: 'biometric-package-experiment-v1', status: 'experiment_only', packageHash: input.request.packageHash,
        frozenInput: { hash: input.request.inputHash, frameCount: 2 } })
      expect(report.results).toHaveLength(2)
    }
    finally { await rm(root, { recursive: true, force: true }) }
  }, 20000)
  it('repeats in fresh containers and detects changing state even with identical readings', async () => {
    const input = options(program)
    const stable = await checkPackageDeterminism({ ...input, frames: () => input.frames })
    expect(stable.deterministic).toBe(true)
    expect(stable.runs).toHaveLength(2)
    const unstable = options(program.replace('import json, sys', 'import json, sys, secrets').replace('\'state\': {}', '\'state\': {\'nonce\': secrets.token_hex(16)}'))
    expect((await checkPackageDeterminism({ ...unstable, frames: () => unstable.frames })).deterministic).toBe(false)
  }, 20000)
  it('rejects a locked Python version that differs from the actual image before running code', async () => {
    const input = options('raise AssertionError("candidate must not run")')
    const wrong = JSON.parse(lockBytes.toString())
    wrong.pythonVersion = '0.0.0'
    const bytes = Buffer.from(JSON.stringify(wrong))
    input.files.set(input.manifest.dependencyLock, bytes)
    input.manifest.artifacts = input.manifest.artifacts.map(artifact => artifact.path === input.manifest.dependencyLock
      ? { ...artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      : artifact)
    input.request.packageHash = configHash(input.manifest)
    await expect(executePackageExperiment(input)).rejects.toThrow('differs from dependency lock')
  }, 20000)
  it('terminates an output flood without buffering it', async () => {
    await expect(executePackageExperiment(options('import sys\nsys.stdout.write(\'x\' * 1000000)\nsys.stdout.flush()\n'))).rejects.toThrow('Output transport limit')
  }, 20000)
  it('terminates a package that never responds', async () => {
    const input = options('while True: pass\n')
    input.manifest.resources.cpuMs = 1000
    input.request.packageHash = configHash(input.manifest)
    await expect(executePackageExperiment(input)).rejects.toThrow('deadline')
  }, 20000)
  it('terminates memory exhaustion', async () => {
    await expect(executePackageExperiment(options('data = bytearray(256 * 1024 * 1024)\n'))).rejects.toThrow()
  }, 20000)
  it('rejects invalid output identities and operator limit excess', async () => {
    await expect(executePackageExperiment(options(program.replace('init[\'runHash\']', '\'b\' * 64')))).rejects.toThrow('identity')
    const substituted = options(program)
    substituted.frames[0].samples.left[0]++
    await expect(executePackageExperiment(substituted)).rejects.toThrow('input identity mismatch')
    const input = options(program)
    input.policy.maximumMemoryBytes = 1
    await expect(executePackageExperiment(input)).rejects.toThrow('operator resource policy')
  }, 20000)
})
