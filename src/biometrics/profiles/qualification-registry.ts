import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { configHash } from '../algorithms/canonical'
import { manifestHash } from '../algorithms/registry'
import { experimentProtocolSchema, numericObjectivePolicies } from '../backtest/contracts'
import { replayContextQualificationSchema } from './replay-context'
import type { DesignatedEvaluationPolicies } from './evaluation-assessment'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const qualificationRegistrySchema = z.object({
  version: z.literal('biometric-promotion-qualifications-v1'),
  entries: z.array(z.object({
    qualificationId: z.string().min(1).max(200), manifestHash: hash, evaluatorBuildHash: hash,
    pythonBuildHash: hash.optional(), protocol: experimentProtocolSchema,
    fixtureEvidenceHash: hash, podEvidenceHash: hash,
    waveformContext: replayContextQualificationSchema.nullable(),
  }).strict()).max(32),
}).strict()
export const unqualifiedPolicies = (): DesignatedEvaluationPolicies => ({ protocolHash: null, waveformContext: null, numeric: null, stages: null })

/** Release-installed authority only. No RPC can write this file. Evidence hashes
 * identify the reviewed qualification artifacts; they are not client assertions. */
export async function installedPromotionPolicies(workerPath: string, identity: {
  evaluatorBuildHash: string
  pythonBuildHash?: string
  protocolHash: string
}): Promise<DesignatedEvaluationPolicies> {
  try {
    const file = await open(join(dirname(workerPath), 'promotion-qualifications.json'), 'r')
    let raw: Buffer
    try {
      if (!(await file.stat()).isFile()) return unqualifiedPolicies()
      const buffer = Buffer.alloc(256 * 1024 + 1)
      let size = 0
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, size)
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size === buffer.length) return unqualifiedPolicies()
      raw = buffer.subarray(0, size)
    }
    finally { await file.close() }
    const registry = qualificationRegistrySchema.parse(JSON.parse(raw.toString('utf8')))
    const matches = registry.entries.filter(entry => entry.manifestHash === manifestHash
      && entry.evaluatorBuildHash === identity.evaluatorBuildHash && entry.pythonBuildHash === identity.pythonBuildHash
      && configHash(entry.protocol) === identity.protocolHash)
    if (matches.length !== 1) return unqualifiedPolicies()
    const entry = matches[0]
    const numeric = numericObjectivePolicies(entry.protocol)
    const stages = entry.protocol.stageObjectivePolicy
    if (!stages || [stages, ...numeric].some(policy => policy.qualificationId !== entry.qualificationId)
      || (entry.protocol.mode === 'signal_replay' && (!entry.pythonBuildHash || !entry.waveformContext))
      || (entry.protocol.mode !== 'signal_replay' && (entry.pythonBuildHash || entry.waveformContext))) return unqualifiedPolicies()
    return { protocolHash: identity.protocolHash, numeric, stages, waveformContext: entry.waveformContext }
  }
  catch { return unqualifiedPolicies() }
}
