// @vitest-environment node
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as biometricsSchema from '@/src/db/biometrics-schema'
import { packagedShadowHostPath } from '../../backtest/location'
import { startShadowService } from '../service-host'
import { configuredShadowService, startConfiguredShadowService } from '../startup'

vi.mock('../../backtest/location', () => ({ packagedShadowHostPath: vi.fn(() => '/installed/shadow-host.cjs') }))
vi.mock('../service-host', () => ({ startShadowService: vi.fn() }))
const cleanup: (() => void)[] = []
const policy = () => ({ version: 'shadow-service-configuration-v1', pythonPath: '/installed/python', modulesPath: '/installed/modules', presenceFile: '/run/presence.json',
  storagePolicy: { maximumRuns: 10, maximumPoints: 1000, maximumBytes: 1000000 }, busyTimeoutMs: 50, recoveryIntervalMs: 1000, recoveryMaximumRuns: 10 })
function databases(memory = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'shadow-startup-')))
  const configPath = join(directory, 'config.db'), bioPath = join(directory, 'bio.db')
  const config = new Database(memory ? ':memory:' : configPath), bio = new Database(bioPath)
  cleanup.push(() => {
    config.close()
    bio.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { config: drizzle(config, { schema: configSchema }), bio: drizzle(bio, { schema: biometricsSchema }), configPath, bioPath }
}
beforeEach(() => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup.splice(0).forEach(close => close())
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('leaves scheduling disabled without explicit configuration', () => {
  const { config, bio } = databases()
  expect(configuredShadowService()).toBeNull()
  expect(startConfiguredShadowService(config, bio)).toBeNull()
  expect(packagedShadowHostPath).not.toHaveBeenCalled()
  expect(startShadowService).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled()
})

it('wires deployment policy to the actual application databases and fixed package', () => {
  const { config, bio, configPath, bioPath } = databases()
  const raw = policy()
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', JSON.stringify(raw))
  startConfiguredShadowService(config, bio)
  expect(startShadowService).toHaveBeenCalledWith({ installation: { workerPath: '/installed/shadow-host.cjs',
    pythonPath: raw.pythonPath, modulesPath: raw.modulesPath, presenceFile: raw.presenceFile,
    configurationDatabase: configPath, biometricsDatabase: bioPath }, storagePolicy: raw.storagePolicy,
  busyTimeoutMs: 50, recoveryIntervalMs: 1000, recoveryMaximumRuns: 10 })
})

it.each([
  'null', '{broken', 'x'.repeat(16385),
  JSON.stringify({ ...policy(), pythonPath: 'relative/python' }),
  JSON.stringify({ ...policy(), recoveryIntervalMs: 0 }),
  JSON.stringify({ ...policy(), busyTimeoutMs: 1001 }),
  JSON.stringify({ ...policy(), configurationDatabase: '/other.db' }),
  JSON.stringify({ ...policy(), workerPath: '/other.cjs' }),
])('refuses invalid startup configuration without echoing its contents (%#)', (raw) => {
  const { config, bio } = databases()
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', raw)
  expect(startConfiguredShadowService(config, bio)).toBeNull()
  expect(startShadowService).not.toHaveBeenCalled()
  expect(packagedShadowHostPath).not.toHaveBeenCalled()
  expect(console.warn).toHaveBeenCalledWith('[biometrics] Shadow service unavailable; check deployment configuration and installed package')
})

it('requires persistent databases and contains missing-package startup failure', () => {
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', JSON.stringify(policy()))
  const memory = databases(true)
  expect(startConfiguredShadowService(memory.config, memory.bio)).toBeNull()
  expect(startShadowService).not.toHaveBeenCalled()
  const persistent = databases()
  vi.mocked(packagedShadowHostPath).mockImplementationOnce(() => {
    throw new Error('missing')
  })
  expect(startConfiguredShadowService(persistent.config, persistent.bio)).toBeNull()
  expect(startShadowService).not.toHaveBeenCalled()
})
