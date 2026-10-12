import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { resolveStageClassifier, stageClassifierSchema } from '@/src/lib/sleep-stage-rules'
import { configHash } from '../algorithms/canonical'
import { defaultConfig, manifestHash, validateConfig } from '../algorithms/registry'
import { runtimePayloadSchema } from './runtime'
import { ProfileStore } from './store'

export const stageViewSchema = z.object({
  classifier: stageClassifierSchema,
  isDefault: z.boolean(),
  provenance: z.object({
    interpretation: z.literal('current_classifier_view'), source: z.enum(['runtime', 'legacy', 'default', 'demo']),
    generation: z.number().int().nullable(), revisionId: z.string().nullable(),
    bundleHash: z.string(), stageHash: z.string(), manifestHash: z.string().nullable(),
    effectiveSampleTimeMs: z.number().nullable(), warning: z.string().nullable(),
  }),
})
export type StageView = z.infer<typeof stageViewSchema>
type ConfigDB = BetterSQLite3Database<typeof configSchema>
type BioDB = BetterSQLite3Database<typeof bioSchema>
type Side = 'left' | 'right'

/** The stage consumer follows the boundary actually reached by all numerical
 * components. Desired intent alone must never rescore history early. */
export function resolveStageView(configDb: ConfigDB, bioDb: BioDB, side: Side): StageView {
  const projection = bioSchema.biometricRuntimeConfigs
  const heart = alias(bioSchema.biometricRuntimeReceipts, 'stage_heart')
  const breathing = alias(bioSchema.biometricRuntimeReceipts, 'stage_breathing')
  const hrv = alias(bioSchema.biometricRuntimeReceipts, 'stage_hrv')
  const match = (receipt: typeof heart | typeof breathing | typeof hrv, component: string) => and(
    eq(receipt.side, projection.side), eq(receipt.generation, projection.generation),
    eq(receipt.appliedHash, projection.resolvedHash), eq(receipt.component, component),
    eq(receipt.state, 'applied'), isNotNull(receipt.effectiveSampleTimeMs),
  )
  const eligible = bioDb.select({ projection,
    heartTime: heart.effectiveSampleTimeMs, breathingTime: breathing.effectiveSampleTimeMs, hrvTime: hrv.effectiveSampleTimeMs,
  }).from(projection)
    .innerJoin(heart, match(heart, 'heart_rate'))
    .innerJoin(breathing, match(breathing, 'breathing_rate'))
    .innerJoin(hrv, match(hrv, 'hrv_index'))
    .where(eq(projection.side, side)).orderBy(desc(projection.generation)).limit(1).get()
  const desiredWarning = new ProfileStore(configDb).effective(side).warning
  let warning: string | null = desiredWarning
  if (eligible) {
    try {
      if (eligible.heartTime === null || eligible.breathingTime === null || eligible.hrvTime === null) throw new Error('Missing runtime boundary')
      const row = eligible.projection
      const payload = runtimePayloadSchema.parse(row.payload)
      const resolved = validateConfig(payload.resolved)
      if (payload.side !== side || payload.generation !== row.generation || payload.boundary !== row.boundary
        || payload.manifestHash !== manifestHash || payload.resolvedHash !== row.resolvedHash || configHash(resolved) !== row.resolvedHash) {
        throw new Error('Incompatible runtime projection')
      }
      return { classifier: resolved.sleep_stages, isDefault: configHash(resolved.sleep_stages) === configHash(defaultConfig.sleep_stages),
        provenance: { interpretation: 'current_classifier_view', source: 'runtime', generation: row.generation,
          revisionId: payload.revisionId, bundleHash: row.resolvedHash, stageHash: configHash(resolved.sleep_stages), manifestHash,
          effectiveSampleTimeMs: Math.max(eligible.heartTime, eligible.breathingTime, eligible.hrvTime), warning: payload.revisionId === null ? desiredWarning : null } }
    }
    catch {
      warning = 'Applied profile is incompatible with this build; stage view uses system defaults'
    }
  }
  // Preserve legacy behavior until its first migration/adoption. Incompatible
  // engines must visibly fall back to shipped defaults, never be relabeled.
  const legacy = warning
    ? null
    : configDb.select({ classifier: configSchema.sideSettings.stageClassifier })
      .from(configSchema.sideSettings).where(eq(configSchema.sideSettings.side, side)).get()?.classifier
  const classifier = resolveStageClassifier(legacy)
  const personalized = legacy != null && stageClassifierSchema.safeParse(legacy).success
  if (legacy != null && !personalized) warning = 'Stored legacy stage rules are invalid; using system defaults'
  return { classifier, isDefault: !personalized,
    provenance: { interpretation: 'current_classifier_view', source: personalized ? 'legacy' : 'default', generation: null,
      revisionId: null, bundleHash: configHash({ ...defaultConfig, sleep_stages: classifier }), stageHash: configHash(classifier),
      manifestHash: personalized ? null : manifestHash, effectiveSampleTimeMs: null, warning } }
}

/** Call at the stage-consumer read boundary. This acknowledges rules delivered
 * for classification, not canonical historical stage observations. */
export function consumeStageView(configDb: ConfigDB, bioDb: BioDB, side: Side, now = Date.now()): StageView {
  return bioDb.transaction((tx) => {
    const view = resolveStageView(configDb, tx, side)
    const provenance = view.provenance
    if (provenance.source === 'runtime' && provenance.generation !== null) {
      const receipt = bioSchema.biometricRuntimeReceipts
      tx.insert(receipt).values({ side, component: 'sleep_stages', generation: provenance.generation,
        appliedHash: provenance.bundleHash, effectiveSampleTimeMs: provenance.effectiveSampleTimeMs,
        state: 'applied', error: null, heartbeatAtMs: now,
      }).onConflictDoUpdate({ target: [receipt.side, receipt.component, receipt.generation],
        set: { appliedHash: provenance.bundleHash, effectiveSampleTimeMs: provenance.effectiveSampleTimeMs,
          state: 'applied', error: null, heartbeatAtMs: now } }).run()
    }
    return view
  }, { behavior: 'immediate' })
}
