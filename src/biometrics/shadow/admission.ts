import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { dataHash } from '../algorithms/canonical'
import { manifestHash } from '../algorithms/registry'
import { admissionPolicySchema, evaluateAdmission } from '../backtest/admission'
import { shadowPlanSchema } from './store'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const shadowQualificationSchema = z.object({ qualificationId: z.string().min(1).max(200),
  manifestHash: hash, engineBuildHash: hash, pythonBuildHash: hash, hardwareId: z.string().min(1).max(200),
  sampleRateHz: z.literal(500), activeConfigHash: hash, executionPolicyHash: hash,
  fixtureEvidenceHash: hash, podEvidenceHash: hash, heldOutEvidenceHash: hash,
  contextEvidence: z.literal('host_observations_not_live_processor_cache_attestation'),
  maximumHardwareObservationAgeMs: integer.positive().max(300000),
  maximumRuntimeHeartbeatAgeMs: integer.positive().max(300000), healthPolicy: admissionPolicySchema,
}).strict().refine(entry => entry.healthPolicy.qualificationId === entry.qualificationId, 'Qualification policy identity mismatch')
export const shadowQualificationRegistrySchema = z.object({ version: z.literal('biometric-shadow-qualifications-v1'),
  entries: z.array(shadowQualificationSchema).max(32) }).strict()
const identitySchema = z.object({ engineBuildHash: hash, pythonBuildHash: hash, hardwareId: z.string().min(1).max(200), sampleRateHz: z.literal(500) }).strict()
const bindingSchema = z.object({ side: z.enum(['left', 'right']), generation: integer, resolvedHash: hash,
  appliedHash: hash, appliedGeneration: integer, state: z.literal('applied'), heartbeatAtMs: integer }).strict()

/** Read release-installed authority beside the trusted worker entrypoint. The
 * file has no write API. Missing, ambiguous or changed evidence denies admission.
 * Evidence hashes refer to reviewed artifacts; arbitrary supplied JSON is not
 * a qualification and callers must never choose this filesystem location. */
export function readInstalledShadowQualifications(workerPath: string) {
  let fd: number | undefined
  try {
    fd = openSync(join(dirname(workerPath), 'shadow-qualifications.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > 256 * 1024) throw new Error('Invalid shadow qualification file')
    const bytes = Buffer.alloc(256 * 1024 + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    if (length > 256 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Shadow qualification file changed or exceeded its bound')
    return shadowQualificationRegistrySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))))
  }
  catch { throw new Error('Installed shadow qualification unavailable') }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** All observations come from trusted host collectors, never RPC fields.
 * Snapshot generation at factory creation prevents a same-hash reset/rollback
 * from silently continuing an attempt across a changed active binding. */
export function installedShadowAdmitter(options: {
  workerPath: string
  expectedBinding: { side: 'left' | 'right', generation: number, resolvedHash: string }
  identity: () => unknown
  binding: () => unknown
  health: () => unknown
  now?: () => number
}) {
  const expected = z.object({ side: bindingSchema.shape.side, generation: integer, resolvedHash: hash }).strict().parse(structuredClone(options.expectedBinding))
  const now = options.now ?? Date.now, workerPath = options.workerPath
  const identityReader = options.identity, bindingReader = options.binding, healthReader = options.health
  const snapshot = (read: () => unknown) => {
    const value = read()
    if (value && typeof value === 'object' && 'then' in value && typeof value.then === 'function') {
      void Promise.resolve(value).catch(() => {})
      throw new Error('Shadow admission observations must be synchronous')
    }
    return value
  }
  return (rawPlan: unknown): void => {
    const plan = shadowPlanSchema.parse(rawPlan)
    if (!plan.execution) throw new Error('Shadow execution policy is missing')
    const registry = readInstalledShadowQualifications(workerPath)
    const entries = registry.entries.filter(entry => dataHash(entry) === plan.qualificationHash)
    if (entries.length !== 1) throw new Error('Shadow qualification missing or ambiguous')
    const entry = entries[0], identity = identitySchema.parse(snapshot(identityReader)), binding = bindingSchema.parse(snapshot(bindingReader)), at = now()
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid shadow admission clock')
    if (entry.manifestHash !== manifestHash || entry.engineBuildHash !== plan.engineBuildHash
      || entry.engineBuildHash !== identity.engineBuildHash || entry.pythonBuildHash !== identity.pythonBuildHash
      || entry.hardwareId !== identity.hardwareId || entry.sampleRateHz !== identity.sampleRateHz
      || entry.executionPolicyHash !== dataHash(plan.execution) || entry.activeConfigHash !== plan.activeConfigHash) throw new Error('Shadow qualification does not match installed execution')
    if (binding.side !== plan.side || binding.side !== expected.side || binding.generation !== expected.generation
      || binding.resolvedHash !== expected.resolvedHash || binding.resolvedHash !== plan.activeConfigHash
      || binding.appliedHash !== binding.resolvedHash || binding.appliedGeneration !== binding.generation
      || at < binding.heartbeatAtMs || at - binding.heartbeatAtMs > entry.maximumRuntimeHeartbeatAgeMs) throw new Error('Shadow active binding changed, unapplied or stale')
    const decision = evaluateAdmission(snapshot(healthReader), entry.healthPolicy, at)
    if (!decision.admitted) throw new Error(`Shadow host admission refused: ${decision.reasons.join(',')}`)
  }
}
