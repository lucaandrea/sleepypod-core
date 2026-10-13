import { withBiometricBackgroundSlot } from '../../background-admission'
// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { dataHash } from '../../algorithms/canonical'
import { inspectInstalledShadowHost, loadInstalledShadowHost } from '../installed-host'
import { installedShadowIdentity } from '../device-identity'
import { openShadowStateDatabase } from '../active-database'
import { runInstalledShadowAttempt, reconcileInstalledShadowRuns, pendingInstalledShadowRun } from '../installed-attempt'
vi.mock('../installed-host', () => ({ inspectInstalledShadowHost: vi.fn(), loadInstalledShadowHost: vi.fn() }))
vi.mock('../device-identity', () => ({ installedShadowIdentity: vi.fn() }))
vi.mock('../active-database', () => ({ openShadowStateDatabase: vi.fn() }))
vi.mock('@/src/streaming/piezoStream', () => ({ getSensorFrameTimes: () => ({ 'piezo-dual': 1234 }) }))
const runId = '11111111-1111-4111-8111-111111111111'
const paths = { workerPath: '/trusted/shadow-host.cjs', pythonPath: '/trusted/python', modulesPath: '/trusted/modules',
  configurationDatabase: '/trusted/config.db', biometricsDatabase: '/trusted/bio.db', presenceFile: '/trusted/presence' }
function setup() {
  const entry = { qualificationId: 'test' }
  const plan = { expectedBindings: { left: { generation: 1, resolvedHash: 'a'.repeat(64) }, right: { generation: 1, resolvedHash: 'a'.repeat(64) } }, candidateRevisionId: null as string | null | undefined, qualificationHash: dataHash(entry), execution: { sources: { databaseBusyTimeoutMs: 50 } } }
  const get = vi.fn(() => ({ plan })), execute = vi.fn().mockResolvedValue('completed')
  const registry = vi.fn(() => ({ entries: [entry] })), guard = vi.fn()
  const recover = vi.fn(() => ({ scanned: 1, recovered: [], nextCursor: null }))
  const pending = vi.fn(() => ({ run: { runId, revisionId: null }, nextCursor: runId }))
  class Store {
    pending = pending
    get = get
    reconcileExpired = recover
  }
  const inspected = { api: { ShadowStore: Store, runProfiledShadowAttempt: execute, readInstalledShadowQualifications: registry }, assertCurrent: guard }
  vi.mocked(inspectInstalledShadowHost).mockResolvedValue(inspected as unknown as Awaited<ReturnType<typeof inspectInstalledShadowHost>>)
  vi.mocked(loadInstalledShadowHost).mockReturnValue(inspected as unknown as ReturnType<typeof loadInstalledShadowHost>)
  const database = { db: {}, close: vi.fn(), assertCurrent: vi.fn() }
  vi.mocked(openShadowStateDatabase).mockReturnValue(database as unknown as ReturnType<typeof openShadowStateDatabase>)
  const identity = vi.fn(() => ({ hardwareId: 'test', sampleRateHz: 500 as const, engineBuildHash: 'a'.repeat(64), pythonBuildHash: 'b'.repeat(64) }))
  vi.mocked(installedShadowIdentity).mockReturnValue(identity)
  return { plan, execute, registry, guard, database, identity, recover, pending }
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

it('reconciles through the installed store without starting probes, hardware checks or workers', () => {
  const { recover, execute, database, guard } = setup()
  expect(reconcileInstalledShadowRuns(paths, {}, 50, { maximumRuns: 10 })).toEqual({ scanned: 1, recovered: [], nextCursor: null })
  expect(recover).toHaveBeenCalledWith({ maximumRuns: 10 })
  expect(database.assertCurrent).toHaveBeenCalledTimes(2)
  expect(guard).toHaveBeenCalledTimes(2)
  expect(database.close).toHaveBeenCalledOnce()
  expect(inspectInstalledShadowHost).not.toHaveBeenCalled()
  expect(installedShadowIdentity).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it.each([undefined, '22222222-2222-4222-8222-222222222222'])('refuses missing or substituted saved revision %s', async (revision) => {
  const { plan, execute, database } = setup()
  plan.candidateRevisionId = revision
  await expect(runInstalledShadowAttempt(runId, null, paths, {}, 50)).rejects.toThrow('revision differs')
  expect(execute).not.toHaveBeenCalled()
  expect(database.close).toHaveBeenCalledOnce()
})
it('reads pending identity from the installed store without worker inspection', () => {
  const { pending, database } = setup()
  expect(pendingInstalledShadowRun(paths, {}, 50, { maximumRuns: 10 })).toEqual({ run: { runId, revisionId: null }, nextCursor: runId })
  expect(pending).toHaveBeenCalledWith({ maximumRuns: 10 })
  expect(inspectInstalledShadowHost).not.toHaveBeenCalled()
  expect(database.close).toHaveBeenCalledOnce()
})

it('defers before inspection or claim while coordinator work owns application capacity', async () => {
  const { execute, database } = setup()
  let finish!: () => void
  const busy = withBiometricBackgroundSlot('work', () => new Promise<void>((resolve) => {
    finish = resolve
  }))
  try {
    await expect(runInstalledShadowAttempt(runId, null, paths, {}, 50)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    expect(inspectInstalledShadowHost).not.toHaveBeenCalled()
    expect(openShadowStateDatabase).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  }
  finally {
    finish()
    await busy
  }
  expect(await runInstalledShadowAttempt(runId, null, paths, {}, 50)).toBe('completed')
  expect(database.close).toHaveBeenCalledOnce()
})
