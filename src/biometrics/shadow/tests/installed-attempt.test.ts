// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { dataHash } from '../../algorithms/canonical'
import { inspectInstalledShadowHost } from '../installed-host'
import { installedShadowIdentity } from '../device-identity'
import { openShadowStateDatabase } from '../active-database'
import { runInstalledShadowAttempt } from '../installed-attempt'
vi.mock('../installed-host', () => ({ inspectInstalledShadowHost: vi.fn() }))
vi.mock('../device-identity', () => ({ installedShadowIdentity: vi.fn() }))
vi.mock('../active-database', () => ({ openShadowStateDatabase: vi.fn() }))
vi.mock('@/src/streaming/piezoStream', () => ({ getSensorFrameTimes: () => ({ 'piezo-dual': 1234 }) }))
const runId = '11111111-1111-4111-8111-111111111111'
const paths = { workerPath: '/trusted/shadow-host.cjs', pythonPath: '/trusted/python', modulesPath: '/trusted/modules',
  configurationDatabase: '/trusted/config.db', biometricsDatabase: '/trusted/bio.db', presenceFile: '/trusted/presence' }
function setup() {
  const entry = { qualificationId: 'test' }
  const plan = { qualificationHash: dataHash(entry), execution: { sources: { databaseBusyTimeoutMs: 50 } } }
  const get = vi.fn(() => ({ plan })), execute = vi.fn().mockResolvedValue('completed')
  const registry = vi.fn(() => ({ entries: [entry] })), guard = vi.fn()
  class Store { get = get }
  const inspected = { api: { ShadowStore: Store, runProfiledShadowAttempt: execute, readInstalledShadowQualifications: registry }, assertCurrent: guard }
  vi.mocked(inspectInstalledShadowHost).mockResolvedValue(inspected as unknown as Awaited<ReturnType<typeof inspectInstalledShadowHost>>)
  const database = { db: {}, close: vi.fn(), assertCurrent: vi.fn() }
  vi.mocked(openShadowStateDatabase).mockReturnValue(database as unknown as ReturnType<typeof openShadowStateDatabase>)
  const identity = vi.fn(() => ({ hardwareId: 'test', sampleRateHz: 500 as const, engineBuildHash: 'a'.repeat(64), pythonBuildHash: 'b'.repeat(64) }))
  vi.mocked(installedShadowIdentity).mockReturnValue(identity)
  return { plan, execute, registry, guard, database, identity }
}
beforeEach(() => vi.resetAllMocks())
it('executes the loaded package with real frame-clock wiring and guarded state ownership', async () => {
  const { execute, guard, database, identity } = setup()
  execute.mockImplementation(async (_store, id, installation, revision) => {
    expect(id).toBe(runId)
    expect(revision).toBeNull()
    expect(installation.piezoReceivedAt()).toBe(1234)
    expect(installation.identity()).toMatchObject({ hardwareId: 'test', sampleRateHz: 500 })
    expect(database.close).not.toHaveBeenCalled()
    return 'completed'
  })
  expect(await runInstalledShadowAttempt(runId, null, paths, {}, 50)).toBe('completed')
  expect(guard).toHaveBeenCalledOnce()
  expect(database.assertCurrent).toHaveBeenCalledTimes(2)
  expect(identity).toHaveBeenCalledTimes(2)
  expect(database.close).toHaveBeenCalledOnce()
})
it.each(['qualification', 'timeout', 'identity', 'execution'])('closes state and refuses invalid %s', async (mode) => {
  const { registry, plan, identity, execute, database } = setup()
  if (mode === 'qualification') registry.mockReturnValue({ entries: [] })
  if (mode === 'timeout') plan.execution.sources.databaseBusyTimeoutMs = 49
  if (mode === 'identity') identity.mockImplementation(() => {
    throw new Error('identity unavailable')
  })
  if (mode === 'execution') execute.mockRejectedValue(new Error('worker failed'))
  await expect(runInstalledShadowAttempt(runId, null, paths, {}, 50)).rejects.toThrow()
  expect(database.close).toHaveBeenCalledOnce()
  if (mode !== 'execution') expect(execute).not.toHaveBeenCalled()
})
it('does not open state after cancelled inspection', async () => {
  setup()
  const abort = new AbortController()
  const pending = runInstalledShadowAttempt(runId, null, paths, {}, 50, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow(/cancelled/)
  expect(openShadowStateDatabase).not.toHaveBeenCalled()
})
