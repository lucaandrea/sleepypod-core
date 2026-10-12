// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { DEFAULT_STAGE_CLASSIFIER } from '@/src/lib/sleep-stage-rules'
import { startBiometricRuntime, stopBiometricRuntime, tickBiometricRuntime } from '../runtime-host'
let configRaw: Database.Database, bioRaw: Database.Database
let config: ReturnType<typeof drizzle<typeof configSchema>>, bio: ReturnType<typeof drizzle<typeof bioSchema>>
beforeEach(() => {
  configRaw = new Database(':memory:')
  bioRaw = new Database(':memory:')
  config = drizzle(configRaw, { schema: configSchema })
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(config, { migrationsFolder: 'src/db/migrations' })
  migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
  config.insert(configSchema.sideSettings).values([{ side: 'left', name: 'Left', stageClassifier: DEFAULT_STAGE_CLASSIFIER }, { side: 'right', name: 'Right' }]).run()
})
afterEach(() => {
  stopBiometricRuntime()
  vi.useRealTimers()
  configRaw.close()
  bioRaw.close()
})
it('migrates once, delivers, and repairs projections after history reset without inventing adoption', () => {
  expect(tickBiometricRuntime(config, bio).errors).toEqual([])
  expect(tickBiometricRuntime(config, bio).errors).toEqual([])
  expect(config.select().from(configSchema.biometricProfileRevisions).all()).toHaveLength(1)
  expect(bio.select().from(bioSchema.biometricRuntimeConfigs).all()).toHaveLength(1)
  expect(config.select().from(configSchema.biometricActivationEvents).get()?.state).toBe('pending_boundary')
  bio.delete(bioSchema.biometricRuntimeConfigs).run()
  expect(tickBiometricRuntime(config, bio).errors).toEqual([])
  expect(bio.select().from(bioSchema.biometricRuntimeConfigs).all()).toHaveLength(1)
  expect(bio.select().from(bioSchema.biometricRuntimeReceipts).all()).toEqual([])
})
it('continues other recovery work when one legacy side is malformed', () => {
  configRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run('{}', 'right')
  expect(tickBiometricRuntime(config, bio).errors).toEqual(['migration:right'])
  expect(bio.select().from(bioSchema.biometricRuntimeConfigs).get()?.side).toBe('left')
})
it('shares one timer across starts and stops cleanly', () => {
  vi.useFakeTimers()
  startBiometricRuntime(config, bio)
  startBiometricRuntime(config, bio)
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(5000)
  expect(config.select().from(configSchema.biometricProfileRevisions).all()).toHaveLength(1)
  stopBiometricRuntime()
  expect(vi.getTimerCount()).toBe(0)
})
