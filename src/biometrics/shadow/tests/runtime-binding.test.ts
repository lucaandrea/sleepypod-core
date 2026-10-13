// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as configSchema from '../../../db/schema'
import * as bioSchema from '../../../db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig } from '../../algorithms/registry'
import { requestManualActivation } from '../../profiles/activation'
import { deliverRuntimeOutbox } from '../../profiles/runtime'
import { resolveShadowProfiles } from '../profiles'
import { ProfileStore } from '../../profiles/store'
import { shadowRuntimeBindingReader } from '../runtime-binding'
const at = 1700000000000, hash = configHash(defaultConfig)
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-binding-'))
  const config = new Database(join(root, 'config.db')), bio = new Database(join(root, 'bio.db'))
  const configDb = drizzle(config, { schema: configSchema }), bioDb = drizzle(bio, { schema: bioSchema })
  migrate(configDb, { migrationsFolder: 'src/db/migrations' })
  migrate(bioDb, { migrationsFolder: 'src/db/biometrics-migrations' })
  for (const side of ['left', 'right'] as const) {
    requestManualActivation(configDb, { side, action: 'reset', revisionId: null, expectedGeneration: 0,
      expectedResolvedHash: hash, boundary: 'immediate', requester: 'fixture', idempotencyKey: side, allowUnvalidated: true }, at - 2000)
  }
  deliverRuntimeOutbox(configDb, bioDb, at - 1000)
  for (const side of ['left', 'right'] as const) {
    for (const component of ['heart_rate', 'breathing_rate', 'hrv_index']) {
      bioDb.insert(bioSchema.biometricRuntimeReceipts).values({ side, component, generation: 1, appliedHash: hash,
        effectiveSampleTimeMs: at - 1000, heartbeatAtMs: at, state: 'applied' }).run()
    }
  }
  const configReader = new Database(join(root, 'config.db'), { readonly: true }), bioReader = new Database(join(root, 'bio.db'), { readonly: true })
  cleanups.push(() => {
    configReader.close()
    bioReader.close()
    config.close()
    bio.close()
    rmSync(root, { recursive: true, force: true })
  })
  const options = { side: 'left' as const, expected: { left: { generation: 1, resolvedHash: hash }, right: { generation: 1, resolvedHash: hash } },
    assertCurrent: () => {}, now: () => at }
  return { configDb, config, bio, configReader, bioReader, options, read: shadowRuntimeBindingReader(configReader, bioReader, options) }
}
it('aggregates both channels without requiring an on-demand stage receipt', () => {
  const { read, bio, options } = setup()
  bio.prepare('UPDATE biometric_runtime_receipts SET heartbeat_at_ms = ? WHERE side = \'right\' AND component = \'hrv_index\'').run(at - 500)
  options.expected.right.generation = 99 // caller mutation cannot change captured identity
  expect(read()).toEqual({ side: 'left', generation: 1, resolvedHash: hash, appliedGeneration: 1, appliedHash: hash, state: 'applied', heartbeatAtMs: at - 500 })
})
it.each(['left', 'right'])('rejects same-hash desired resets on %s', (side) => {
  const { config, read } = setup()
  config.prepare('UPDATE biometric_profile_bindings SET generation = 2 WHERE side = ?').run(side)
  expect(read).toThrow(/generation changed/)
})
it.each([
  'DELETE FROM biometric_runtime_receipts WHERE side = \'right\' AND component = \'breathing_rate\'',
  'UPDATE biometric_runtime_receipts SET state = \'pending_boundary\' WHERE component = \'hrv_index\'',
  'UPDATE biometric_runtime_receipts SET state = \'failed\' WHERE component = \'heart_rate\'',
  'UPDATE biometric_runtime_receipts SET effective_sample_time_ms = NULL WHERE component = \'hrv_index\'',
  'UPDATE biometric_runtime_receipts SET generation = 2 WHERE side = \'right\'',
  'UPDATE biometric_runtime_receipts SET applied_hash = \'wrong\' WHERE side = \'right\'',
  `UPDATE biometric_runtime_receipts SET heartbeat_at_ms = ${at + 1} WHERE side = 'right'`,
  `UPDATE biometric_runtime_receipts SET effective_sample_time_ms = ${at + 1} WHERE side = 'right'`,
])('rejects missing, unapplied, changed or future component evidence: %s', (sql) => {
  const { bio, read } = setup()
  bio.exec(sql)
  expect(read).toThrow()
})
it.each(['DELETE FROM biometric_runtime_configs WHERE side = \'right\'',
  'UPDATE biometric_runtime_configs SET resolved_hash = \'wrong\' WHERE side = \'right\'',
  'UPDATE biometric_runtime_configs SET payload = \'{}\' WHERE side = \'right\'',
  'UPDATE biometric_runtime_configs SET payload = printf(\'%070000d\', 0) WHERE side = \'right\''])('rejects unavailable or corrupt installed projection: %s', (sql) => {
  const { bio, read } = setup()
  bio.exec(sql)
  expect(read).toThrow()
})
it('requires read-only handles and propagates post-snapshot identity failure', () => {
  const { config, bio, configReader, bioReader, options } = setup()
  expect(() => shadowRuntimeBindingReader(config, bio, options)).toThrow(/read-only/)
  let checks = 0
  const read = shadowRuntimeBindingReader(configReader, bioReader, { ...options, assertCurrent: () => {
    if (++checks === 3) throw new Error('database replaced')
  } })
  expect(read).toThrow(/database replaced/)
})
it('refuses desired hash changes even when all old receipts remain applied', () => {
  const { config, read } = setup()
  config.prepare('UPDATE biometric_activation_events SET next_hash = \'changed\' WHERE side = \'right\'').run()
  expect(read).toThrow(/configuration changed/)
})
it('does not fall back to an older applied generation behind a pending receipt', () => {
  const { bio, read } = setup()
  bio.prepare(`INSERT INTO biometric_runtime_receipts
    (side, component, generation, applied_hash, effective_sample_time_ms, heartbeat_at_ms, state)
    VALUES ('right', 'heart_rate', 2, ?, NULL, ?, 'pending_boundary')`).run(hash, at)
  expect(read).toThrow()
})

function savedPlan() {
  const execution = { version: 'shadow-execution-policy-v1', configHashes: { left: hash, right: hash },
    maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
    budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 10000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
    leaseMs: 1500, heartbeatMs: 200, sources: { pollMs: 50, maximumActiveRows: 10, databaseBusyTimeoutMs: 50,
      frames: { maximumFrames: 10, maximumBytes: 100000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
      context: { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 4096 } } }
  const plan = { schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'test', execution, startMs: at, endMs: at + 10000,
    candidateConfigHash: hash, activeConfigHash: hash, engineBuildHash: hash, qualificationHash: 'a'.repeat(64), maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 100, drainGraceMs: 500 },
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 1000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }
  return plan
}

it('resolves the saved candidate while preserving acknowledged other-channel config', () => {
  const { configDb, configReader, bioReader } = setup()
  const revision = new ProfileStore(configDb).createRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
    origin: 'manual', requester: 'test', idempotencyKey: 'candidate' })
  const plan = savedPlan()
  plan.candidateConfigHash = revision.resolvedHash
  plan.execution.configHashes.left = revision.resolvedHash
  const result = resolveShadowProfiles(configReader, bioReader, plan, revision.id, () => {}, at)
  expect(result.configs.left).toEqual(revision.resolved)
  expect(result.configs.right).toEqual(defaultConfig)
  expect(result.expectedBindings).toEqual({ left: { generation: 1, resolvedHash: hash }, right: { generation: 1, resolvedHash: hash } })
  expect(result.revisionId).toBe(revision.id)
})
it('allows explicit default candidates but refuses unstored active defaults', () => {
  const { config, configReader, bioReader } = setup()
  expect(resolveShadowProfiles(configReader, bioReader, savedPlan(), null, () => {}, at).configs.left).toEqual(defaultConfig)
  config.prepare('DELETE FROM biometric_profile_bindings WHERE side = \'right\'').run()
  expect(() => resolveShadowProfiles(configReader, bioReader, savedPlan(), null, () => {}, at)).toThrow()
})
it('refuses a same-hash active generation change from a queued plan', () => {
  const { configReader, bioReader } = setup()
  const expectedBindings = { left: { generation: 1, resolvedHash: hash }, right: { generation: 1, resolvedHash: hash } }
  expect(resolveShadowProfiles(configReader, bioReader, { ...savedPlan(), expectedBindings }, null, () => {}, at).expectedBindings).toEqual(expectedBindings)
  expectedBindings.right.generation = 2
  expect(() => resolveShadowProfiles(configReader, bioReader, { ...savedPlan(), expectedBindings }, null, () => {}, at)).toThrow('generations differ')
})
it('rejects wrong-side or corrupted revisions and frozen physical-channel substitution', () => {
  const { configDb, config, configReader, bioReader } = setup()
  const revision = new ProfileStore(configDb).createRevision({ side: 'right', overrides: [], origin: 'manual', requester: 'test', idempotencyKey: 'candidate' })
  const plan = savedPlan()
  expect(() => resolveShadowProfiles(configReader, bioReader, plan, revision.id, () => {}, at)).toThrow(/other side/)
  config.prepare('UPDATE biometric_profile_revisions SET side = \'left\', resolved_hash = \'corrupt\' WHERE id = ?').run(revision.id)
  expect(() => resolveShadowProfiles(configReader, bioReader, plan, revision.id, () => {}, at)).toThrow(/integrity/)
  plan.execution.configHashes.right = 'b'.repeat(64)
  expect(() => resolveShadowProfiles(configReader, bioReader, plan, null, () => {}, at)).toThrow(/physical-channel/)
})
it('refuses unapplied baselines and writable profile resolution handles', () => {
  const { config, bio, configReader, bioReader } = setup()
  expect(() => resolveShadowProfiles(config, bio, savedPlan(), null, () => {}, at)).toThrow(/read-only/)
  bio.prepare('UPDATE biometric_runtime_receipts SET state = \'pending_boundary\' WHERE side = \'right\'').run()
  expect(() => resolveShadowProfiles(configReader, bioReader, savedPlan(), null, () => {}, at)).toThrow()
})
