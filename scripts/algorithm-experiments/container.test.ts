// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { packageFixture } from '../../src/biometrics/packages/tests/fixture'
import { checkPackageDeterminism } from './determinism'
import { packageInputHash } from './input'
import { executePackageExperiment } from './container'

const image = process.env.BIOMETRIC_EXPERIMENT_TEST_IMAGE
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
    const result = await executePackageExperiment(options(probes + program))
    expect(result.results).toHaveLength(2)
    expect(result.execution.isolation).toBe('docker-restricted-v1')
  }, 20000)
  it('repeats in fresh containers and detects changing state even with identical readings', async () => {
    const input = options(program)
    const stable = await checkPackageDeterminism({ ...input, frames: () => input.frames })
    expect(stable.deterministic).toBe(true)
    expect(stable.runs).toHaveLength(2)
    const unstable = options(program.replace('import json, sys', 'import json, sys, secrets').replace('\'state\': {}', '\'state\': {\'nonce\': secrets.token_hex(16)}'))
    expect((await checkPackageDeterminism({ ...unstable, frames: () => unstable.frames })).deterministic).toBe(false)
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
