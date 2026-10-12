// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { requestManualActivation } from '../activation'
import { recoverRuntimeIntent } from '../recovery'
import { ProfileStore } from '../store'
import { deliverRuntimeOutbox, reconcileActivation, RUNTIME_COMPONENTS } from '../runtime'
import { tickBiometricRuntime } from '../runtime-host'
import { resolveStageView } from '../stage-view'
let configRaw: Database.Database, bioRaw: Database.Database
let config: ReturnType<typeof drizzle<typeof configSchema>>, bio: ReturnType<typeof drizzle<typeof bioSchema>>
const now = 1791673200000
beforeEach(() => {
  configRaw = new Database(':memory:')
  bioRaw = new Database(':memory:')
  config = drizzle(configRaw, { schema: configSchema })
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(config, { migrationsFolder: 'src/db/migrations' })
  migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
})
afterEach(() => {
  configRaw.close()
  bioRaw.close()
})
function activate(custom = false) {
  const revision = custom
    ? new ProfileStore(config).createRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
        origin: 'manual', requester: 'fixture', idempotencyKey: 'profile' })
    : null
  requestManualActivation(config, { side: 'left', action: revision ? 'activate' : 'reset', revisionId: revision?.id ?? null, expectedGeneration: 0,
    expectedResolvedHash: revision?.resolvedHash ?? configHash(defaultConfig), boundary: 'next_session', requester: 'fixture', idempotencyKey: 'activate', allowUnvalidated: true }, now)
  return revision
}
function obsoleteProjection() {
  const row = config.select().from(configSchema.biometricConfigOutbox).get()
  if (!row) throw new Error('Missing projection')
  configRaw.prepare('UPDATE biometric_config_outbox SET payload = ?').run(JSON.stringify({ ...row.payload as object, manifestHash: 'previous-build' }))
}
describe('runtime recovery across builds', () => {
  it('keeps implicit defaults implicit and does not supersede valid next-session intent', () => {
    expect(recoverRuntimeIntent(config, 'left', now)).toBeNull()
    activate()
    expect(recoverRuntimeIntent(config, 'left', now)).toBeNull()
    expect(new ProfileStore(config).binding('left').generation).toBe(1)
  })
  it('refreshes an obsolete shipped default once and preserves its audit explanation after acknowledgment', () => {
    activate()
    obsoleteProjection()
    const event = recoverRuntimeIntent(config, 'left', now)
    expect(event?.evidence).toMatchObject({ status: 'system_default_update', manifestHash })
    expect(event?.generation).toBe(2)
    expect(recoverRuntimeIntent(config, 'left', now)).toBeNull()
    deliverRuntimeOutbox(config, bio, now)
    for (const component of RUNTIME_COMPONENTS) bio.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation: 2,
      appliedHash: configHash(defaultConfig), state: 'applied', effectiveSampleTimeMs: now, heartbeatAtMs: now }).run()
    expect(reconcileActivation(config, bio, 'left', now)?.state).toBe('applied')
    expect(config.select().from(configSchema.biometricActivationEvents).all().find(row => row.generation === 2)?.reason).toContain('Refresh shipped')
  })
  it('preserves pinned intent and rollback history during fallback, including after biometric reset', () => {
    const revision = activate(true)
    if (!revision) throw new Error('Missing revision')
    configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ? WHERE id = ?').run('previous-build', revision.id)
    expect(tickBiometricRuntime(config, bio, now).errors).toEqual([])
    const binding = new ProfileStore(config).binding('left')
    expect(binding).toMatchObject({ desiredRevisionId: revision.id, previousRevisionId: null, generation: 2 })
    const projection = bio.select().from(bioSchema.biometricRuntimeConfigs).get()
    expect(projection?.payload).toMatchObject({ revisionId: null, resolvedHash: configHash(defaultConfig) })
    expect(config.select().from(configSchema.biometricActivationEvents).all().find(row => row.generation === 2)?.evidence).toMatchObject({ status: 'profile_incompatible', requestedRevisionId: revision.id })
    bio.delete(bioSchema.biometricRuntimeConfigs).run()
    tickBiometricRuntime(config, bio, now)
    expect(new ProfileStore(config).binding('left').generation).toBe(2)
    expect(bio.select().from(bioSchema.biometricRuntimeConfigs).get()?.generation).toBe(2)
    for (const component of RUNTIME_COMPONENTS.slice(0, 3)) bio.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation: 2,
      appliedHash: configHash(defaultConfig), state: 'applied', effectiveSampleTimeMs: now, heartbeatAtMs: now }).run()
    expect(resolveStageView(config, bio, 'left').provenance.warning).toContain('PROFILE_INCOMPATIBLE')
    expect(config.select().from(configSchema.biometricProfileRevisions).get()?.id).toBe(revision.id)
  })
  it('restores a compatible-again pinned revision at the next session, never silently rewriting old snapshots', () => {
    const revision = activate(true)
    if (!revision) throw new Error('Missing revision')
    configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ?').run('previous-build')
    recoverRuntimeIntent(config, 'left', now)
    configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ?').run(manifestHash)
    const restored = recoverRuntimeIntent(config, 'left', now)
    expect(restored?.evidence).toMatchObject({ status: 'profile_restored', actualRevisionId: revision.id })
    expect(config.select().from(configSchema.biometricConfigOutbox).all().find(row => row.generation === 3)?.payload)
      .toMatchObject({ boundary: 'next_session', resolvedHash: revision.resolvedHash })
    expect(new ProfileStore(config).binding('left').desiredRevisionId).toBe(revision.id)
  })
  it('repairs a missing custom intent conservatively at the next session', () => {
    activate(true)
    config.delete(configSchema.biometricConfigOutbox).run()
    const event = recoverRuntimeIntent(config, 'left', now)
    expect(event?.evidence).toMatchObject({ status: 'runtime_repair' })
    expect(config.select().from(configSchema.biometricConfigOutbox).get()?.payload).toMatchObject({ boundary: 'next_session' })
  })
  it('repairs conflicting biometric projections through a new generation while retaining the corrupt row for diagnosis', () => {
    activate(true)
    tickBiometricRuntime(config, bio, now)
    bioRaw.prepare('UPDATE biometric_runtime_configs SET payload = ?').run('{}')
    tickBiometricRuntime(config, bio, now + 1)
    expect(config.select().from(configSchema.biometricConfigOutbox).get()?.state).toBe('failed')
    tickBiometricRuntime(config, bio, now + 2)
    expect(new ProfileStore(config).binding('left').generation).toBe(2)
    const rows = bio.select().from(bioSchema.biometricRuntimeConfigs).all()
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.generation === 1)?.payload).toEqual({})
    expect(rows.find(row => row.generation === 2)?.payload).toMatchObject({ boundary: 'next_session' })
  })
  it('rolls back all recovery changes when outbox persistence fails', () => {
    activate()
    obsoleteProjection()
    configRaw.exec('CREATE TRIGGER reject_recovery BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'full\'); END;')
    expect(() => recoverRuntimeIntent(config, 'left', now)).toThrow('full')
    expect(new ProfileStore(config).binding('left').generation).toBe(1)
    expect(config.select().from(configSchema.biometricActivationEvents).all()).toHaveLength(1)
    expect(config.select().from(configSchema.biometricConfigOutbox).get()?.state).toBe('pending')
  })
})
