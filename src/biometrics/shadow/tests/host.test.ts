// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { resolveShadowProfiles } from '../profiles'
import { dataHash } from '../../algorithms/canonical'
import { openPlannedShadowHost, openProfiledShadowHost, runPlannedShadowAttempt, runProfiledShadowAttempt } from '../host'
import { openShadowActiveDatabase } from '../active-database'
import { openShadowHealthMonitor } from '../health-monitor'
import { installedShadowAdmitter, readInstalledShadowQualifications } from '../admission'
import { plannedShadowSourceFactory } from '../planned-sources'
import { shadowRuntimeBindingReader } from '../runtime-binding'
import { runShadowAttempt } from '../attempt'
import type { ShadowStore } from '../store'
vi.mock('../profiles', () => ({ resolveShadowProfiles: vi.fn() }))
vi.mock('../active-database', () => ({ openShadowActiveDatabase: vi.fn() }))
vi.mock('../health-monitor', () => ({ openShadowHealthMonitor: vi.fn() }))
vi.mock('../admission', () => ({ installedShadowAdmitter: vi.fn(), readInstalledShadowQualifications: vi.fn() }))
vi.mock('../planned-sources', () => ({ plannedShadowSourceFactory: vi.fn() }))
vi.mock('../runtime-binding', () => ({ shadowRuntimeBindingReader: vi.fn() }))
vi.mock('../attempt', () => ({ runShadowAttempt: vi.fn() }))
const a = 'a'.repeat(64), now = 1700000000000
function setup() {
  const entry = { healthPolicy: { qualificationId: 'test' } }
  const execution = { version: 'shadow-execution-policy-v1', configHashes: { left: a, right: a },
    maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
    budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 10000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
    leaseMs: 1500, heartbeatMs: 200, sources: { pollMs: 50, maximumActiveRows: 10, databaseBusyTimeoutMs: 50,
      frames: { maximumFrames: 10, maximumBytes: 100000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
      context: { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 4096 } } }
  const plan = { schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'test', execution, startMs: now, endMs: now + 10000,
    candidateConfigHash: a, activeConfigHash: a, engineBuildHash: a, qualificationHash: dataHash(entry), maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 100, drainGraceMs: 500 },
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 1000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }
  const databases = [0, 1].map(() => ({ db: {}, close: vi.fn(), assertCurrent: vi.fn() }))
  vi.mocked(openShadowActiveDatabase).mockReturnValueOnce(databases[0] as unknown as ReturnType<typeof openShadowActiveDatabase>)
    .mockReturnValueOnce(databases[1] as unknown as ReturnType<typeof openShadowActiveDatabase>)
  vi.mocked(readInstalledShadowQualifications).mockReturnValue({ entries: [entry] } as unknown as ReturnType<typeof readInstalledShadowQualifications>)
  const health = { read: vi.fn(), close: vi.fn() }, admit = vi.fn(), sources = vi.fn()
  vi.mocked(openShadowHealthMonitor).mockResolvedValue(health)
  vi.mocked(installedShadowAdmitter).mockReturnValue(admit)
  vi.mocked(plannedShadowSourceFactory).mockReturnValue(sources)
  vi.mocked(shadowRuntimeBindingReader).mockReturnValue(vi.fn())
  const installation = { workerPath: '/trusted/worker.cjs', pythonPath: '/trusted/python', modulesPath: '/trusted/modules',
    configurationDatabase: '/trusted/config.db', biometricsDatabase: '/trusted/bio.db', presenceFile: '/trusted/presence.json',
    configs: { left: {}, right: {} }, expectedBindings: { left: { generation: 1, resolvedHash: a }, right: { generation: 2, resolvedHash: a } }, identity: vi.fn(), piezoReceivedAt: vi.fn(() => now) }
  return { plan, installation, databases, health, admit, sources }
}
beforeEach(() => vi.resetAllMocks())
it('composes frozen policy, both binding guards and sampled health before returning a host', async () => {
  const { plan, installation, databases, health, admit, sources } = setup()
  const owned = await openPlannedShadowHost(plan, installation)
  expect(admit).toHaveBeenCalledOnce()
  expect(openShadowActiveDatabase).toHaveBeenCalledWith('/trusted/config.db', { busyTimeoutMs: 50 })
  const bindingOptions = vi.mocked(shadowRuntimeBindingReader).mock.calls[0][2]
  bindingOptions.assertCurrent()
  databases.forEach(db => expect(db.assertCurrent).toHaveBeenCalledOnce())
  expect(bindingOptions.expected.right.generation).toBe(2)
  expect(openShadowHealthMonitor).toHaveBeenCalledWith('/trusted', { qualificationId: 'test' }, installation.piezoReceivedAt, owned.signal)
  expect(owned.host.openSources).toBe(sources)
  installation.configs.left = { changed: true }
  expect(owned.host.configs.left).toEqual({})
  expect(() => owned.host.admit({ ...plan, endMs: plan.endMs + 1 } as Parameters<typeof owned.host.admit>[0])).toThrow(/plan changed/)
  owned.close()
  owned.close()
  expect(owned.signal.aborted).toBe(true)
  databases.forEach(db => expect(db.close).toHaveBeenCalledOnce())
  expect(health.close).toHaveBeenCalledOnce()
  expect(() => owned.host.admit(plan as Parameters<typeof owned.host.admit>[0])).toThrow(/closed/)
})
it('unwinds the first connection when the second database fails', async () => {
  const { plan, installation, databases, health } = setup()
  vi.mocked(openShadowActiveDatabase).mockReset().mockReturnValueOnce(databases[0] as unknown as ReturnType<typeof openShadowActiveDatabase>)
    .mockImplementationOnce(() => { throw new Error('open failed') })
  await expect(openPlannedShadowHost(plan, installation)).rejects.toThrow(/open failed/)
  expect(databases[0].close).toHaveBeenCalledOnce()
  expect(openShadowHealthMonitor).not.toHaveBeenCalled()
  expect(health.close).not.toHaveBeenCalled()
})
it('unwinds both connections and health when initial admission fails', async () => {
  const { plan, installation, databases, health, admit } = setup()
  admit.mockImplementation(() => {
    throw new Error('unqualified')
  })
  await expect(openPlannedShadowHost(plan, installation)).rejects.toThrow(/unqualified/)
  databases.forEach(db => expect(db.close).toHaveBeenCalledOnce())
  expect(health.close).toHaveBeenCalledOnce()
})
it('cleans up a late health handle after cancellation during startup', async () => {
  const { plan, installation, databases, health } = setup()
  let resolve!: (value: typeof health) => void
  vi.mocked(openShadowHealthMonitor).mockImplementation(() => new Promise((done) => {
    resolve = done
  }))
  const abort = new AbortController()
  const pending = openPlannedShadowHost(plan, installation, abort.signal)
  abort.abort()
  resolve(health)
  await expect(pending).rejects.toThrow(/cancelled/)
  databases.forEach(db => expect(db.close).toHaveBeenCalledOnce())
  expect(health.close).toHaveBeenCalledOnce()
})
it('rejects pre-cancellation and missing qualification before opening resources', async () => {
  const { plan, installation } = setup()
  const abort = new AbortController()
  abort.abort()
  await expect(openPlannedShadowHost(plan, installation, abort.signal)).rejects.toThrow(/cancelled/)
  vi.mocked(readInstalledShadowQualifications).mockReturnValue({ version: 'biometric-shadow-qualifications-v1', entries: [] })
  await expect(openPlannedShadowHost(plan, installation)).rejects.toThrow(/qualification/)
  expect(openShadowActiveDatabase).not.toHaveBeenCalled()
})
it('closes host resources when the attempt rejects after startup', async () => {
  const { plan, installation, databases, health } = setup()
  vi.mocked(runShadowAttempt).mockRejectedValue(new Error('claim failed'))
  const store = { get: () => ({ plan }) } as unknown as ShadowStore
  await expect(runPlannedShadowAttempt(store, 'test', installation)).rejects.toThrow(/claim failed/)
  databases.forEach(db => expect(db.close).toHaveBeenCalledOnce())
  expect(health.close).toHaveBeenCalledOnce()
})
it('closes admission connections when health collection rejects', async () => {
  const { plan, installation, databases, health } = setup()
  vi.mocked(openShadowHealthMonitor).mockRejectedValue(new Error('health unavailable'))
  await expect(openPlannedShadowHost(plan, installation)).rejects.toThrow(/health unavailable/)
  databases.forEach(db => expect(db.close).toHaveBeenCalledOnce())
  expect(health.close).not.toHaveBeenCalled()
  expect(plannedShadowSourceFactory).not.toHaveBeenCalled()
})

it('resolves profiles using temporary handles then reopens admission with captured generations', async () => {
  const { plan, installation, databases } = setup()
  const capture = [0, 1].map(() => ({ db: {}, close: vi.fn(), assertCurrent: vi.fn() }))
  vi.mocked(openShadowActiveDatabase).mockReset()
  for (const db of [...capture, ...databases]) vi.mocked(openShadowActiveDatabase).mockReturnValueOnce(db as unknown as ReturnType<typeof openShadowActiveDatabase>)
  vi.mocked(resolveShadowProfiles).mockReturnValue({ revisionId: null, configs: installation.configs,
    expectedBindings: installation.expectedBindings, heartbeatAtMs: now } as ReturnType<typeof resolveShadowProfiles>)
  vi.mocked(runShadowAttempt).mockImplementation(async () => {
    capture.forEach(db => expect(db.close).toHaveBeenCalledOnce())
    databases.forEach(db => expect(db.close).not.toHaveBeenCalled())
    throw new Error('test attempt finished')
  })
  const store = { get: () => ({ plan }) } as unknown as ShadowStore
  await expect(runProfiledShadowAttempt(store, 'test', installation, null)).rejects.toThrow(/test attempt finished/)
  expect(resolveShadowProfiles).toHaveBeenCalledWith(capture[0].db, capture[1].db, plan, null, expect.any(Function))
  databases.forEach(db => expect(db.close).toHaveBeenCalledOnce())
})

it('checks both captured database identities during profile resolution and closes them on rejection', async () => {
  const { plan, installation, databases } = setup()
  vi.mocked(resolveShadowProfiles).mockImplementation((_config, _bio, _plan, _revision, assertCurrent) => {
    assertCurrent()
    throw new Error('profile incompatible')
  })
  await expect(openProfiledShadowHost(plan, installation, null)).rejects.toThrow('profile incompatible')
  databases.forEach((db) => {
    expect(db.assertCurrent).toHaveBeenCalledOnce()
    expect(db.close).toHaveBeenCalledOnce()
  })
  expect(openShadowHealthMonitor).not.toHaveBeenCalled()
  expect(runShadowAttempt).not.toHaveBeenCalled()
})

it('unwinds profile capture if the biometrics database cannot be opened', async () => {
  const { plan, installation, databases } = setup()
  vi.mocked(openShadowActiveDatabase).mockReset().mockReturnValueOnce(databases[0] as unknown as ReturnType<typeof openShadowActiveDatabase>)
    .mockImplementationOnce(() => { throw new Error('open failed') })
  await expect(openProfiledShadowHost(plan, installation, null)).rejects.toThrow('open failed')
  expect(databases[0].close).toHaveBeenCalledOnce()
  expect(resolveShadowProfiles).not.toHaveBeenCalled()
})

it('requires execution policy before opening either kind of host and honors pre-cancellation', async () => {
  const { plan, installation } = setup()
  const withoutExecution: Partial<typeof plan> = { ...plan }
  delete withoutExecution.execution
  await expect(openPlannedShadowHost(withoutExecution, installation)).rejects.toThrow(/execution policy/)
  await expect(openProfiledShadowHost(withoutExecution, installation, null)).rejects.toThrow(/execution policy/)
  await expect(openProfiledShadowHost(plan, installation, null, AbortSignal.abort())).rejects.toThrow(/cancelled/)
  expect(openShadowActiveDatabase).not.toHaveBeenCalled()
})
