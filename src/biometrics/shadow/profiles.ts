import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/schema'
import { configHash, dataHash } from '../algorithms/canonical'
import { defaultConfig, validateConfig } from '../algorithms/registry'
import { ProfileStore } from '../profiles/store'
import { runtimePayloadSchema } from '../profiles/runtime'
import { shadowRuntimeBindingReader } from './runtime-binding'
import { shadowPlanSchema } from './store'

/** Resolve a saved candidate and acknowledged baselines without activating or
 * repairing anything. Null revision explicitly selects the shipped default.
 * Both physical channels must have adopted their current desired generation. */
export function resolveShadowProfiles(configuration: Database.Database, biometrics: Database.Database, rawPlan: unknown,
  rawRevisionId: string | null, assertCurrent: () => void, now = Date.now()) {
  const plan = shadowPlanSchema.parse(rawPlan), revisionId = z.string().uuid().nullable().parse(rawRevisionId)
  if (!plan.execution) throw new Error('Shadow profile resolution requires execution policy')
  if (plan.candidateRevisionId !== undefined && plan.candidateRevisionId !== revisionId) throw new Error('Shadow candidate revision differs from saved plan')
  const execution = plan.execution
  for (const db of [configuration, biometrics]) {
    if (!db.open || (!db.readonly && db.pragma('query_only', { simple: true }) !== 1)) throw new Error('Shadow profile resolution requires read-only databases')
  }
  const check = () => {
    const value: unknown = assertCurrent()
    if (value !== undefined) {
      void Promise.resolve(value).catch(() => {})
      throw new Error('Shadow profile identity guard must be synchronous')
    }
  }
  check()
  const result = configuration.transaction(() => biometrics.transaction(() => {
    const profiles = new ProfileStore(drizzle(configuration, { schema }))
    const candidate = revisionId === null ? structuredClone(defaultConfig) : profiles.validateRevision(revisionId, plan.side).resolved
    if (configHash(candidate) !== plan.candidateConfigHash) throw new Error('Shadow candidate differs from saved plan')
    const capture = (side: 'left' | 'right') => {
      const desired = z.object({ generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), resolvedHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(configuration.prepare(`SELECT b.generation, e.next_hash AS resolvedHash FROM biometric_profile_bindings b
          JOIN biometric_activation_events e ON e.side = b.side AND e.generation = b.generation WHERE b.side = ?`).get(side))
      const row = biometrics.prepare(`SELECT CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload ELSE NULL END AS payload
        FROM biometric_runtime_configs WHERE side = ? AND generation = ?`).get(side, desired.generation) as { payload: string | null } | undefined
      if (!row?.payload) throw new Error('Shadow baseline projection missing or oversized')
      const payload = runtimePayloadSchema.parse(JSON.parse(row.payload))
      return { expected: desired, resolved: validateConfig(payload.resolved) }
    }
    const left = capture('left'), right = capture('right')
    const expectedBindings = { left: left.expected, right: right.expected }
    const binding = shadowRuntimeBindingReader(configuration, biometrics, { side: plan.side, expected: expectedBindings, assertCurrent: check, now: () => now })()
    if (binding.resolvedHash !== plan.activeConfigHash) throw new Error('Shadow active baseline differs from saved plan')
    const configs = { left: left.resolved, right: right.resolved, [plan.side]: candidate }
    if (dataHash({ left: configHash(configs.left), right: configHash(configs.right) }) !== dataHash(execution.configHashes)) throw new Error('Shadow physical-channel configs differ from saved plan')
    return { revisionId, configs, expectedBindings, heartbeatAtMs: binding.heartbeatAtMs }
  })())()
  check()
  return structuredClone(result)
}
