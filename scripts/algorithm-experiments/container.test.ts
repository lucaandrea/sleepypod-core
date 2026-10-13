import { fixtureResourceTestPolicy } from './resource-test-policy'
// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { statSync } from 'node:fs'
import * as frozenInput from './input'
import * as resourceReader from './resources'
import { tmpdir } from 'node:os'
import { runPackageFixtures } from './fixtures'
import { runExperimentCli } from './cli'
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
    expect(result.execution.measurements.samples).toBeGreaterThan(0)
    expect(result.execution.measurements.maximumObservedCpuMs).toBeGreaterThan(0)
    expect(result.execution.measurements.peakObservedMemoryBytes).toBeGreaterThan(0)
    expect(result.execution.measurements).toMatchObject({ source: 'host_docker_engine_stats', exactPeakMemory: false, exactLifetimeCpu: false })
    expect(result.results).toHaveLength(2)
    expect(result.execution.isolation).toBe('docker-restricted-v1')
  }, 20000)
  it('keeps the host staging parent private while the unprivileged container reads its package mount', async () => {
    let parent: string | undefined
    let modes: number[] | undefined
    const freeze = frozenInput.freezePackageInput
    const readResources = resourceReader.dockerResourceReader
    const capture = vi.spyOn(frozenInput, 'freezePackageInput').mockImplementation(async (path, frames, maximumBytes) => {
      parent = dirname(path)
      return freeze(path, frames, maximumBytes)
    })
    const observe = vi.spyOn(resourceReader, 'dockerResourceReader').mockImplementation(async (id) => {
      if (!parent) throw new Error('Missing staged input')
      // This runs after Docker create, when all host permissions are final.
      modes = [parent, join(parent, 'input.jsonl'), join(parent, 'package')].map(path => statSync(path).mode & 0o777)
      return readResources(id)
    })
    try {
      expect((await executePackageExperiment(options(program))).results).toHaveLength(2)
      expect(observe).toHaveBeenCalledOnce()
      expect(modes).toEqual([0o700, 0o600, 0o755])
      const stagedParent = parent
      if (!stagedParent) throw new Error('Missing staging')
      expect(() => statSync(stagedParent)).toThrow()
    }
    finally {
      capture.mockRestore()
      observe.mockRestore()
    }
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
  it('checks numeric coverage and catches false vitals during an empty-bed fixture', async () => {
    const reading = '[{\'timestampMs\': frame[\'timestampMs\'], \'side\': \'left\', \'metric\': \'heart_rate\', \'value\': 60, \'quality\': 1, \'flags\': []}]'
    const makeSuite = (input: ReturnType<typeof options>) => ({ schema: 'biometric-package-fixtures-v1', resourcePolicy: fixtureResourceTestPolicy, fixtures: [true, false].map((occupied) => {
      const frames = input.frames.map(frame => ({ ...frame, context: { ...frame.context, occupied } }))
      return { id: occupied ? 'clean' : 'empty', category: occupied ? 'clean_signal' : 'empty_bed',
        request: { ...input.request, inputHash: packageInputHash(frames) }, frames,
        expectations: [{ metric: 'heart_rate', startMs: 1000, endMs: 1012, ...(occupied
          ? { kind: 'numeric', minimum: 59, maximum: 61, minimumReadings: 2, minimumQuality: 0.8 }
          : { kind: 'abstain' }) }] }
    }) })
    const candidate = options(program.replace('\'readings\': []', `'readings': ${reading} if frame['context']['occupied'] else []`))
    const suite = makeSuite(candidate)
    const running = runPackageFixtures(candidate, suite)
    suite.fixtures[0].frames[0].samples.left[0] = 999
    const report = await running
    expect(report.suite.fixtures[0].frames[0].samples.left?.[0]).toBe(1)
    expect(report.status).toBe('incomplete')
    expect(report.results.every(result => result.assessment.passed)).toBe(true)
    expect(report.missingCategories).toContain('pump')
    const strictBudget = makeSuite(candidate)
    strictBudget.resourcePolicy = { ...fixtureResourceTestPolicy, maximumWallMs: 1 }
    const overBudget = await runPackageFixtures(candidate, strictBudget)
    expect(overBudget.results.every(result => result.assessment.passed)).toBe(true)
    expect(overBudget.results.every(result => result.resourceAssessment?.status === 'failed')).toBe(true)
    expect(overBudget.status).toBe('failed')
    const bad = options(program.replace('\'readings\': []', `'readings': ${reading}`))
    const regression = await runPackageFixtures(bad, makeSuite(bad))
    expect(regression.status).toBe('failed')
    expect(regression.results[1].assessment.failures).toContain('failed_abstention:heart_rate:1000')
  }, 30000)
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
  it('stops a cancelled experiment and removes its container', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1000)
    try {
      await expect(executePackageExperiment({ ...options('import time\ntime.sleep(60)\n'), signal: controller.signal })).rejects.toThrow(/abort/i)
    }
    finally { clearTimeout(timer) }
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
