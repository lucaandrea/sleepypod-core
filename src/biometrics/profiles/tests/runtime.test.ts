// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { requestManualActivation } from '../activation'
import { deliverRuntimeOutbox, projectRuntimeConfig, reconcileActivation, repairCurrentRuntimeProjections, RUNTIME_COMPONENTS } from '../runtime'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig } from '../../algorithms/registry'
let configSqlite: Database.Database, bioSqlite: Database.Database
let configDb: ReturnType<typeof drizzle<typeof configSchema>>, bioDb: ReturnType<typeof drizzle<typeof bioSchema>>
const now = 1791673200000
beforeEach(() => {
  configSqlite = new Database(':memory:')
  bioSqlite = new Database(':memory:')
  configDb = drizzle(configSqlite, { schema: configSchema })
  bioDb = drizzle(bioSqlite, { schema: bioSchema })
  migrate(configDb, { migrationsFolder: 'src/db/migrations' })
  migrate(bioDb, { migrationsFolder: 'src/db/biometrics-migrations' })
  requestManualActivation(configDb, { side: 'left', action: 'reset', revisionId: null, expectedGeneration: 0, expectedResolvedHash: configHash(defaultConfig),
    boundary: 'next_session', requester: 'fixture', idempotencyKey: 'reset', allowUnvalidated: true }, now)
})
afterEach(() => {
  configSqlite.close()
  bioSqlite.close()
})
const payload = () => configDb.select().from(configSchema.biometricConfigOutbox).get()?.payload

describe('runtime projection and acknowledgment', () => {
  it('retries safely after projection succeeds but the configuration acknowledgment fails', () => {
    configSqlite.exec('CREATE TRIGGER reject_delivery BEFORE UPDATE OF state ON biometric_config_outbox WHEN NEW.state = \'delivered\' BEGIN SELECT RAISE(ABORT, \'fixture crash\'); END;')
    expect(deliverRuntimeOutbox(configDb, bioDb, now)).toEqual({ delivered: 0, failed: 1 })
    expect(bioDb.select().from(bioSchema.biometricRuntimeConfigs).all()).toHaveLength(1)
    configSqlite.exec('DROP TRIGGER reject_delivery')
    expect(deliverRuntimeOutbox(configDb, bioDb, now + 1000)).toEqual({ delivered: 1, failed: 0 })
    expect(bioDb.select().from(bioSchema.biometricRuntimeConfigs).all()).toHaveLength(1)
    expect(reconcileActivation(configDb, bioDb, 'left', now + 1000)?.state).toBe('pending_boundary')
    expect(bioDb.select().from(bioSchema.biometricRuntimeReceipts).all()).toEqual([])
  })
  it('requires every matching component receipt and ignores old generations and wrong hashes', () => {
    deliverRuntimeOutbox(configDb, bioDb, now)
    for (const component of RUNTIME_COMPONENTS) bioDb.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation: 0,
      appliedHash: configHash(defaultConfig), state: 'applied', effectiveSampleTimeMs: now, heartbeatAtMs: now }).run()
    expect(reconcileActivation(configDb, bioDb, 'left', now)?.state).toBe('pending_boundary')
    for (const component of RUNTIME_COMPONENTS) bioDb.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation: 1,
      appliedHash: component === 'sleep_stages' ? 'wrong' : configHash(defaultConfig), state: 'applied', effectiveSampleTimeMs: now, heartbeatAtMs: now }).run()
    expect(reconcileActivation(configDb, bioDb, 'left', now)?.state).toBe('pending_boundary')
    bioSqlite.prepare('UPDATE biometric_runtime_receipts SET applied_hash = ? WHERE generation = 1').run(configHash(defaultConfig))
    expect(reconcileActivation(configDb, bioDb, 'left', now)?.state).toBe('applied')
  })
  it('restores the current projection after a history reset and rejects conflicting duplicate generations', () => {
    deliverRuntimeOutbox(configDb, bioDb, now)
    bioDb.delete(bioSchema.biometricRuntimeConfigs).run()
    expect(repairCurrentRuntimeProjections(configDb, bioDb, now)).toBe(1)
    expect(repairCurrentRuntimeProjections(configDb, bioDb, now)).toBe(0)
    expect(() => projectRuntimeConfig(bioDb, { ...(payload() as object), revisionId: '11111111-1111-4111-8111-111111111111' }, now)).toThrow('different immutable payload')
    expect(configDb.select().from(configSchema.biometricProfileBindings).get()?.generation).toBe(1)
  })
  it('marks invalid envelopes failed without projecting or fabricating receipts', () => {
    configSqlite.prepare('UPDATE biometric_config_outbox SET resolved_hash = ?').run('wrong')
    expect(deliverRuntimeOutbox(configDb, bioDb, now)).toEqual({ delivered: 0, failed: 1 })
    expect(reconcileActivation(configDb, bioDb, 'left', now)?.state).toBe('failed')
    expect(bioDb.select().from(bioSchema.biometricRuntimeConfigs).all()).toEqual([])
  })
})
