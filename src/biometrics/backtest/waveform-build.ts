import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { configHash } from '../algorithms/canonical'
import { workerBuildHash } from './child'
import type { WaveformWorkerLocation } from './waveform-child'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const label = z.string().min(1).max(1000)
const dependency = z.object({ version: label, record_sha256: hash, wheel_sha256: hash }).strict()
export const waveformPythonBuildSchema = z.object({ hash, identity: z.object({
  version: z.literal('waveform-python-build-v1'),
  sources: z.record(z.string().regex(/^(common|piezo-processor)\/[A-Za-z0-9_./-]+$/), hash)
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64),
  dependencies: z.object({ numpy: dependency, scipy: dependency }).strict(),
  runtime: z.object({ implementation: label, version: label, cache_tag: label.nullable(), soabi: label.nullable(),
    machine: label, system: label, byteorder: z.enum(['little', 'big']) }).strict(),
}).strict() }).strict()

/** Read-only bounded probe of the exact interpreter used for replay. Locations
 * are trusted deployment configuration; no command or source comes from RPC. */
export async function probeWaveformBuild(location: Pick<WaveformWorkerLocation, 'pythonPath' | 'modulesPath'>, signal?: AbortSignal) {
  const { stdout } = await promisify(execFile)(location.pythonPath, ['-B', '-m', 'common.biometrics.replay_worker', '--describe-build'], {
    cwd: tmpdir(), env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC',
      OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
    encoding: 'utf8', maxBuffer: 65536, timeout: 10000, killSignal: 'SIGKILL', signal,
  }).catch(() => { throw new Error('Waveform build identity is unavailable') })
  const result = waveformPythonBuildSchema.parse(JSON.parse(stdout))
  if (configHash(result.identity) !== result.hash) throw new Error('Waveform build identity integrity mismatch')
  return result
}

/** Pin orchestration, scoring, Python code and installed numerical wheel
 * metadata together. Architecture/runtime changes deliberately invalidate it. */
export async function waveformEvaluatorBuildIdentity(coordinatorPath: string, workerPath: string,
  location: Pick<WaveformWorkerLocation, 'pythonPath' | 'modulesPath'>, signal?: AbortSignal) {
  const [coordinatorHash, evaluatorHash, python] = await Promise.all([
    workerBuildHash(coordinatorPath), workerBuildHash(workerPath), probeWaveformBuild(location, signal),
  ])
  const identity = { version: 'waveform-evaluator-build-v1', coordinatorHash, evaluatorHash, pythonHash: python.hash,
    node: { version: process.version, platform: process.platform, arch: process.arch, icu: process.versions.icu ?? null } }
  return { hash: configHash(identity), identity, python }
}
