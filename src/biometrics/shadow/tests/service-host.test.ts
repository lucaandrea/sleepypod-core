// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runInstalledShadowAttempt, reconcileInstalledShadowRuns, pendingInstalledShadowRun } from '../installed-attempt'
import { startShadowService, stopShadowService } from '../service-host'

vi.mock('../installed-attempt', () => ({ runInstalledShadowAttempt: vi.fn(), reconcileInstalledShadowRuns: vi.fn(), pendingInstalledShadowRun: vi.fn() }))
const runId = '11111111-1111-4111-8111-111111111111'
const options = () => ({ installation: { workerPath: '/trusted/shadow-host.cjs', pythonPath: '/trusted/python', modulesPath: '/trusted/modules',
  configurationDatabase: '/trusted/config.db', biometricsDatabase: '/trusted/bio.db', presenceFile: '/trusted/presence' },
storagePolicy: { maximumRuns: 10, maximumPoints: 1000, maximumBytes: 1000000 }, busyTimeoutMs: 50, recoveryIntervalMs: 1000, recoveryMaximumRuns: 10 })
beforeEach(() => {
  vi.mocked(pendingInstalledShadowRun).mockReturnValue({ run: null, nextCursor: null })
})
afterEach(async () => {
  await stopShadowService()
  vi.resetAllMocks()
})

it('owns one global service, freezes deployment inputs and rejects configuration drift', async () => {
  vi.mocked(reconcileInstalledShadowRuns).mockReturnValue({ scanned: 0, recovered: [], nextCursor: null })
  const raw = options(), original = structuredClone(raw)
  const service = startShadowService(raw)
  expect(startShadowService(options())).toBe(service)
  expect(reconcileInstalledShadowRuns).toHaveBeenCalledOnce()
  raw.installation.workerPath = '/different'
  raw.storagePolicy.maximumRuns = 999
  expect(() => startShadowService(raw)).toThrow('restart required')
  await service.run(runId, null)
  expect(runInstalledShadowAttempt).toHaveBeenCalledWith(runId, null, original.installation,
    original.storagePolicy, 50, expect.any(AbortSignal))
  await stopShadowService()
  expect(() => service.run(runId, null)).toThrow('stopped')
  expect(startShadowService(options())).not.toBe(service)
})

it('keeps the singleton until shutdown finishes worker cleanup', async () => {
  vi.mocked(reconcileInstalledShadowRuns).mockReturnValue({ scanned: 0, recovered: [], nextCursor: null })
  let release!: () => void
  vi.mocked(runInstalledShadowAttempt).mockImplementation(async (_id, _revision, _paths, _policy, _timeout, signal) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    expect(signal?.aborted).toBe(true)
    throw new Error('interrupted')
  })
  const service = startShadowService(options())
  const failed = expect(service.run(runId, null)).rejects.toThrow('interrupted')
  await Promise.resolve()
  const stopping = stopShadowService()
  expect(startShadowService(options())).toBe(service)
  expect(() => service.run(runId, null)).toThrow('stopped')
  release()
  await Promise.all([stopping, failed])
  expect(startShadowService(options())).not.toBe(service)
})
