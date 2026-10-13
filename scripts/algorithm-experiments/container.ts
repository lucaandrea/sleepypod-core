import { recordExperimentStaging } from './staging-recovery'
import { recoveryLabelArguments } from './recovery'
import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { verifyAlgorithmPackage } from '../../src/biometrics/packages/manifest'
import { PackageFrameValidator } from '../../src/biometrics/packages/protocol'
import { dockerResourceReader, startResourceMonitor } from './resources'
import { inspectPythonEnvironment, matchPythonEnvironment, parsePythonEnvironmentLock } from './environment'
import { freezePackageInput, readFrozenPackageInput } from './input'
import { dataHash } from '../../src/biometrics/algorithms/canonical'

const exec = promisify(execFile)
async function removeContainer(name: string) {
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 10000, maxBuffer: 65536 })
  }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No such container:')) throw error
  }
}
/** Operator-owned policy, never accepted from a candidate or pod settings. */
export interface ExperimentPolicy {
  image: string
  maximumWallMs: number
  maximumMemoryBytes: number
  maximumProcesses: number
  maximumOutputBytes: number
  maximumInputBytes: number
}

/** Off-pod CLI only. Do not import from the web application or run on a pod.
 * The image must be a reviewed Python runtime with locked dependencies already
 * installed; dependency installation and network access are not permitted here. */
export async function executePackageExperiment(options: {
  manifest: unknown
  files: ReadonlyMap<string, Uint8Array>
  request: unknown
  frames: Iterable<unknown>
  policy: ExperimentPolicy
  signal?: AbortSignal
}) {
  options.signal?.throwIfAborted()
  if (existsSync('/persistent/deviceinfo/dac.sock') || existsSync('/deviceinfo/dac.sock')) throw new Error('Algorithm experiments must run off-pod')
  const policy = structuredClone(options.policy)
  if (!/^sha256:[a-f0-9]{64}$/.test(policy.image)) throw new Error('A local immutable image ID is required')
  for (const value of [policy.maximumWallMs, policy.maximumMemoryBytes, policy.maximumProcesses, policy.maximumOutputBytes, policy.maximumInputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid experiment policy')
  }
  verifyAlgorithmPackage(options.manifest, options.files)
  const files = new Map([...options.files].map(([path, bytes]) => [path, Buffer.from(bytes)]))
  const verified = verifyAlgorithmPackage(options.manifest, files)
  const validator = new PackageFrameValidator(verified.manifest, options.request)
  const resources = verified.manifest.resources
  if (resources.wallMs > policy.maximumWallMs || resources.memoryBytes > policy.maximumMemoryBytes
    || resources.processes > policy.maximumProcesses || resources.outputBytes > policy.maximumOutputBytes) throw new Error('Package exceeds operator resource policy')
  if (resources.wallMs > 3600000) throw new Error('Experiment deadline exceeds one hour')
  const info = JSON.parse((await exec('docker', ['info', '--format', '{{json .}}'], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout)
  if (info.OSType !== 'linux' || !info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota || !info.SecurityOptions?.some((item: string) => item.startsWith('name=seccomp'))) throw new Error('Docker lacks required isolation controls')
  const lockBytes = files.get(verified.manifest.dependencyLock)
  if (!lockBytes) throw new Error('Missing dependency lock')
  parsePythonEnvironmentLock(lockBytes, policy.image)
  const environment = matchPythonEnvironment(lockBytes, await inspectPythonEnvironment(policy.image), policy.image)
  const root = await mkdtemp(join(tmpdir(), 'sleepypod-package-'))
  const name = `sleepypod-experiment-${randomUUID()}`
  let created = false
  try {
    await recordExperimentStaging(root, name, Math.min(resources.wallMs, resources.cpuMs))
    const inputPath = join(root, 'input.jsonl')
    const frozenInput = await freezePackageInput(inputPath, options.frames, policy.maximumInputBytes)
    if (frozenInput.hash !== validator.request.inputHash) throw new Error('Experiment input identity mismatch')
    const packagePath = join(root, 'package')
    await mkdir(packagePath, { mode: 0o755 })
    // Docker mounts only packagePath; its container UID needs access inside that
    // mount, not traversal of the host parent. Keep the mkdtemp root at 0700 so
    // host users cannot list package source or the private frozen sensor input.
    for (const artifact of verified.manifest.artifacts) {
      const path = join(packagePath, artifact.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      // Copy to privately owned staging so caller mutation cannot alter the mount.
      await writeFile(path, files.get(artifact.path) as Uint8Array, { flag: 'wx', mode: 0o444 })
    }
    // Bound aggregate CPU conservatively: one CPU and a wall deadline no longer
    // than the CPU budget. Idle time consumes that budget too. This is not a
    // measured CPU receipt and cannot qualify a package's runtime performance.
    const deadlineMs = Math.min(resources.wallMs, resources.cpuMs)
    options.signal?.throwIfAborted()
    created = true
    const creation = await exec('docker', ['create', '--name', name, ...recoveryLabelArguments('experiment', deadlineMs), '--network', 'none', '--ipc', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--user', '65534:65534',
      '--pids-limit', String(resources.processes), '--memory', String(resources.memoryBytes),
      '--memory-swap', String(resources.memoryBytes), '--cpus', '1', '--ulimit', 'core=0',
      '--log-driver', 'none', '--restart', 'no', '--no-healthcheck', '-i',
      '--mount', `type=bind,source=${packagePath},target=/package,readonly`, '--workdir', '/package',
      '--entrypoint', 'python', policy.image, '-I', '-B', `/package/${verified.manifest.entrypoint}`],
    { timeout: 10000, maxBuffer: 65536 })
    const resourceReader = await dockerResourceReader(creation.stdout.trim()).catch(() => null)
    const started = performance.now()
    const resourceMonitor = startResourceMonitor(resourceReader, started)
    const child = spawn('docker', ['start', '-ai', name], { stdio: ['pipe', 'pipe', 'pipe'] })
    let failure: Error | null = null
    let pending = Buffer.alloc(0), outputBytes = 0, inputBytes = 0
    let waiting: { resolve: (line: string) => void, reject: (error: Error) => void } | null = null
    let stopPromise: Promise<unknown> | null = null
    const fail = (error: Error) => {
      if (failure) return
      failure = error
      waiting?.reject(error)
      waiting = null
      child.stdin.destroy()
      stopPromise = exec('docker', ['kill', name], { timeout: 10000, maxBuffer: 65536 }).catch(() => undefined)
      child.kill('SIGKILL')
    }
    const abort = () => fail(new Error('Experiment aborted'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdin.on('error', error => fail(error))
    child.on('error', error => fail(error))
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > resources.outputBytes) return fail(new Error('Output transport limit exceeded'))
      pending = Buffer.concat([pending, chunk])
      let newline: number
      while ((newline = pending.indexOf(10)) >= 0) {
        if (!waiting) return fail(new Error('Unexpected package output'))
        const line = pending.subarray(0, newline).toString('utf8')
        pending = pending.subarray(newline + 1)
        const receiver = waiting
        waiting = null
        receiver.resolve(line)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > resources.outputBytes) fail(new Error('Output transport limit exceeded'))
    })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('close', (code) => {
        if (waiting) fail(new Error('Package exited before responding'))
        if (failure) reject(failure)
        else if (code !== 0 || pending.length) reject(new Error(`Package exited with invalid output (exit ${code})`))
        else resolve()
      })
    })
    // Observe immediately, even if a frame iterator is still pending.
    void completion.catch(() => undefined)
    const timer = setTimeout(() => fail(new Error('Package deadline exceeded')), deadlineMs)
    const send = async (value: unknown) => {
      if (failure) throw failure
      const bytes = JSON.stringify(value) + '\n'
      inputBytes += Buffer.byteLength(bytes)
      if (inputBytes > policy.maximumInputBytes) throw new Error('Input transport limit exceeded')
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()))
    }
    const results = []
    try {
      await send({ type: 'initialize', request: validator.request, runHash: validator.runHash })
      for await (const input of readFrozenPackageInput(inputPath)) {
        const { frame } = validator.validateFrame(input)
        const response = new Promise<string>((resolve, reject) => {
          waiting = { resolve, reject }
        })
        void response.catch(() => undefined)
        await send({ type: 'frame', frame, frameHash: dataHash(frame) })
        const result = validator.validateStep(frame, JSON.parse(await response)).result
        results.push(result)
      }
      await resourceMonitor.sample()
      child.stdin.end()
      await completion
      const measurements = await resourceMonitor.stop()
      return { packageHash: verified.packageHash, runHash: validator.runHash, frozenInput, results,
        execution: { limits: resources, measurements, environment, image: policy.image, wallMs: performance.now() - started, outputBytes, inputBytes, isolation: 'docker-restricted-v1' as const } }
    }
    catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      await completion.catch(() => undefined)
      throw error
    }
    finally {
      options.signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      await resourceMonitor.stop()
      if (stopPromise) await stopPromise
    }
  }
  finally {
    // Keep ownership metadata and files if Docker cleanup is unconfirmed.
    if (created) await removeContainer(name)
    await rm(root, { recursive: true, force: true })
  }
}
