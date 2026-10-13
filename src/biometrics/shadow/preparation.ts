import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { configHash, dataHash } from '../algorithms/canonical'
import { manifestHash } from '../algorithms/registry'
import { captureShadowProfiles } from './profiles'
import { readInstalledShadowQualifications } from './admission'
import { prepareShadowRequestSchema, preparedShadowPlanSchema, shadowPlanTemplateSchema } from './preparation-contracts'
import { submitShadowSchema } from './submission-contracts'

/** A server-owned template provides reviewed ceilings, never caller defaults.
 * Preparation proves saved input consistency, not current hardware admission. */
export function prepareShadowPlan(configuration: Database.Database, biometrics: Database.Database,
  rawRequest: z.input<typeof prepareShadowRequestSchema>, rawTemplate: unknown, workerPath: string,
  assertCurrent: () => void, now = Date.now()) {
  const request = prepareShadowRequestSchema.parse(rawRequest), template = shadowPlanTemplateSchema.parse(rawTemplate)
  if (template.id !== request.templateId) throw new Error('Shadow template changed')
  const duration = request.endMs - request.startMs
  if (request.startMs < now || duration <= 0 || duration > template.maximumWindowMs
    || duration + template.joining.drainGraceMs > template.execution.budgets.wallMs) throw new Error('Shadow window exceeds template limits or is not prospective')
  const entries = readInstalledShadowQualifications(workerPath).entries.filter(entry => dataHash(entry) === template.qualificationHash)
  if (entries.length !== 1) throw new Error('Shadow template qualification missing or ambiguous')
  const entry = entries[0]
  if (entry.manifestHash !== manifestHash || entry.executionPolicyHash !== dataHash(template.execution)) throw new Error('Shadow template differs from installed qualification')
  const captured = captureShadowProfiles(configuration, biometrics, request.side, request.candidateRevisionId, assertCurrent, now)
  if (captured.activeConfigHash !== entry.activeConfigHash
    || dataHash({ left: configHash(captured.configs.left), right: configHash(captured.configs.right) }) !== dataHash(template.execution.configHashes)) throw new Error('Shadow template does not match candidate and active profiles')
  const policy = { qualificationHash: template.qualificationHash, execution: template.execution, monitoring: template.monitoring,
    joining: template.joining, metrics: template.metrics, maximumPoints: template.maximumPoints, maximumBytes: template.maximumBytes,
    ...(template.windowIbiWindowMs === undefined ? {} : { windowIbiWindowMs: template.windowIbiWindowMs }) }
  const plan = submitShadowSchema.shape.plan.parse({ ...policy, schema: 'biometric-shadow-plan-v1',
    side: request.side, subjectId: request.subjectId, candidateRevisionId: request.candidateRevisionId,
    startMs: request.startMs, endMs: request.endMs, expectedBindings: captured.expectedBindings,
    candidateConfigHash: captured.candidateConfigHash, activeConfigHash: captured.activeConfigHash, engineBuildHash: entry.engineBuildHash })
  return preparedShadowPlanSchema.parse({ status: 'prepared_not_admitted', plan, planHash: dataHash(plan) })
}
