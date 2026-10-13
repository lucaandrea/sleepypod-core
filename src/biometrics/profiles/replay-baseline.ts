import { and, desc, eq, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { configHash } from '../algorithms/canonical'
import { defaultConfig, manifestHash, validateConfig } from '../algorithms/registry'
import { ReferenceInputError } from '../references/time'
import { runtimePayloadSchema } from './runtime'
import { resolveStageView } from './stage-view'

/** Freeze a coherent numerical baseline, never desired-but-unadopted intent.
 * Call inside the caller's read snapshot when capturing both logical sides. */
export function resolveReplayBaseline(configDb: BetterSQLite3Database<typeof configSchema>, bioDb: BetterSQLite3Database<typeof bioSchema>, side: 'left' | 'right') {
  const receipts = bioSchema.biometricRuntimeReceipts
  const components = ['heart_rate', 'breathing_rate', 'hrv_index']
  const latest = components.map(component => bioDb.select().from(receipts)
    .where(and(eq(receipts.side, side), eq(receipts.component, component), ne(receipts.state, 'pending_boundary'))).orderBy(desc(receipts.generation)).limit(1).get())
  if (latest.some(row => row?.state === 'failed')) throw new ReferenceInputError('MISSING_CONTEXT', 'Numerical adoption failed; inspect runtime health before waveform evaluation')
  // Pending boundary receipts do not replace the last acknowledged generation.
  const applied = components.map(component => bioDb.select().from(receipts)
    .where(and(eq(receipts.side, side), eq(receipts.component, component), eq(receipts.state, 'applied')))
    .orderBy(desc(receipts.generation)).limit(1).get())
  if (applied.every(row => !row)) {
    const view = resolveStageView(configDb, bioDb, side)
    if (view.provenance.warning) throw new ReferenceInputError('MISSING_CONTEXT', 'Current fallback configuration is uncertain; inspect profile compatibility')
    const resolved = validateConfig({ ...structuredClone(defaultConfig), sleep_stages: view.classifier })
    return { resolved, hash: configHash(resolved), revisionId: null,
      provenance: { source: 'unacknowledged_defaults' as const, generation: null, effectiveSampleTimeMs: null,
        warning: 'No numerical configuration has been acknowledged; this baseline uses shipped numerical defaults and the current stage view.' } }
  }
  const first = applied[0]
  if (!first || first.effectiveSampleTimeMs === null || applied.some(row => !row || row.effectiveSampleTimeMs === null
    || row.generation !== first.generation || row.appliedHash !== first.appliedHash)) {
    throw new ReferenceInputError('MISSING_CONTEXT', 'Numerical components have not acknowledged one consistent configuration')
  }
  const projection = bioDb.select().from(bioSchema.biometricRuntimeConfigs).where(and(
    eq(bioSchema.biometricRuntimeConfigs.side, side), eq(bioSchema.biometricRuntimeConfigs.generation, first.generation))).get()
  try {
    if (!projection) throw new Error('Missing projection')
    const payload = runtimePayloadSchema.parse(projection.payload)
    const resolved = validateConfig(payload.resolved)
    if (payload.side !== side || payload.generation !== first.generation || payload.boundary !== projection.boundary
      || payload.manifestHash !== manifestHash || payload.resolvedHash !== first.appliedHash
      || projection.resolvedHash !== first.appliedHash || configHash(resolved) !== first.appliedHash) throw new Error('Inconsistent projection')
    return { resolved, hash: first.appliedHash, revisionId: payload.revisionId,
      provenance: { source: 'acknowledged_runtime' as const, generation: first.generation,
        effectiveSampleTimeMs: Math.max(...applied.map(row => row?.effectiveSampleTimeMs ?? 0)), warning: null } }
  }
  catch { throw new ReferenceInputError('MISSING_CONTEXT', 'Acknowledged numerical configuration is unavailable or incompatible') }
}
