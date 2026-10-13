// @vitest-environment node
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { configHash, dataHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { captureShadowProfiles } from '../profiles'
import { readInstalledShadowQualifications } from '../admission'
import { prepareShadowPlan } from '../preparation'
import { configuredShadowTemplates, prepareInstalledShadow } from '../installed-preparation'
import { openShadowActiveDatabase } from '../active-database'
import { loadInstalledShadowHost } from '../installed-host'
import { submissionFixture, submissionTime } from './fixtures/submission'
vi.mock('../profiles', () => ({ captureShadowProfiles: vi.fn() }))
vi.mock('../admission', () => ({ readInstalledShadowQualifications: vi.fn() }))
vi.mock('../active-database', () => ({ openShadowActiveDatabase: vi.fn() }))
vi.mock('../installed-host', () => ({ loadInstalledShadowHost: vi.fn() }))

const paths = { workerPath: '/installed/shadow-host.cjs', pythonPath: '/installed/python', modulesPath: '/installed/modules',
  configurationDatabase: '/installed/config.db', biometricsDatabase: '/installed/bio.db', presenceFile: '/run/presence' }
const db = {} as Database.Database
function setup() {
  const { plan } = submissionFixture(), hash = configHash(defaultConfig)
  plan.execution.configHashes = { left: hash, right: hash }
  const entry = { manifestHash, executionPolicyHash: dataHash(plan.execution), activeConfigHash: hash, engineBuildHash: 'b'.repeat(64) }
  const template = { id: 'test', label: 'Synthetic fixture', maximumWindowMs: 9000, qualificationHash: dataHash(entry),
    execution: plan.execution, joining: plan.joining, monitoring: plan.monitoring, metrics: plan.metrics,
    maximumPoints: plan.maximumPoints, maximumBytes: plan.maximumBytes }
  const request = { templateId: 'test', side: 'left' as const, subjectId: 'sleeper', candidateRevisionId: null, startMs: submissionTime + 1000, endMs: submissionTime + 9000 }
  const captured = { revisionId: null, configs: { left: defaultConfig, right: defaultConfig },
    expectedBindings: { left: { generation: 4, resolvedHash: hash }, right: { generation: 5, resolvedHash: hash } }, heartbeatAtMs: submissionTime,
    candidateConfigHash: hash, activeConfigHash: hash }
  vi.mocked(captureShadowProfiles).mockReturnValue(captured)
  vi.mocked(readInstalledShadowQualifications).mockReturnValue({ entries: [entry] } as unknown as ReturnType<typeof readInstalledShadowQualifications>)
  const config = { version: 'shadow-service-configuration-v1', pythonPath: paths.pythonPath, modulesPath: paths.modulesPath, presenceFile: paths.presenceFile,
    storagePolicy: { maximumRuns: 10, maximumPoints: 100, maximumBytes: 100000 }, busyTimeoutMs: 50, recoveryIntervalMs: 1000, recoveryMaximumRuns: 10,
    planTemplates: [template] }
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', JSON.stringify(config))
  return { template, request, entry, captured, config }
}
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.unstubAllEnvs())

it('derives candidate/baseline identities and generations from server capture without admitting execution', () => {
  const { request, template, captured, entry } = setup(), guard = vi.fn()
  const prepared = prepareShadowPlan(db, db, request, template, paths.workerPath, guard, submissionTime)
  expect(prepared).toMatchObject({ status: 'prepared_not_admitted', plan: { candidateRevisionId: null,
    expectedBindings: captured.expectedBindings, candidateConfigHash: captured.candidateConfigHash, activeConfigHash: captured.activeConfigHash, engineBuildHash: entry.engineBuildHash } })
  expect(prepared.planHash).toBe(dataHash(prepared.plan))
  expect(captureShadowProfiles).toHaveBeenCalledWith(db, db, 'left', null, guard, submissionTime)
})

it.each(['past', 'duration', 'wall', 'qualification', 'candidate', 'baseline'])('refuses incompatible preparation: %s', (failure) => {
  const { request, template, captured } = setup()
  if (failure === 'past') request.startMs = submissionTime - 1
  if (failure === 'duration') request.endMs += 100000
  if (failure === 'wall') template.execution.budgets.wallMs = 1000
  if (failure === 'qualification') template.qualificationHash = 'f'.repeat(64)
  if (failure === 'candidate') captured.configs.left = { ...defaultConfig, version: 'invalid' } as unknown as typeof defaultConfig
  if (failure === 'baseline') captured.activeConfigHash = 'f'.repeat(64)
  expect(() => prepareShadowPlan(db, db, request, template, paths.workerPath, () => {}, submissionTime)).toThrow()
})

it('lists only template metadata and owns readonly preparation handles on success and failure', () => {
  const { request, template } = setup()
  expect(configuredShadowTemplates()).toEqual({ items: [{ id: 'test', label: 'Synthetic fixture', maximumWindowMs: 9000 }] })
  const handles = [0, 1].map(() => ({ db, close: vi.fn(), assertCurrent: vi.fn() }))
  const prepare = vi.fn(() => ({ status: 'prepared_not_admitted' })), guard = vi.fn()
  vi.mocked(loadInstalledShadowHost).mockReturnValue({ api: { prepareShadowPlan: prepare }, assertCurrent: guard } as unknown as ReturnType<typeof loadInstalledShadowHost>)
  for (const failed of [false, true]) {
    vi.mocked(openShadowActiveDatabase).mockReturnValueOnce(handles[0]).mockReturnValueOnce(handles[1])
    if (failed) prepare.mockImplementationOnce(() => {
      throw new Error('changed')
    })
    if (failed) expect(() => prepareInstalledShadow(request, paths, 50)).toThrow('changed')
    else expect(prepareInstalledShadow(request, paths, 50)).toEqual({ status: 'prepared_not_admitted' })
  }
  expect(prepare).toHaveBeenCalledWith(db, db, request, template, paths.workerPath, expect.any(Function))
  handles.forEach(handle => expect(handle.close).toHaveBeenCalledTimes(2))
})

it('refuses templates that exceed deployment quotas or duplicate an ID', () => {
  const { config } = setup()
  config.storagePolicy.maximumBytes = 1
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', JSON.stringify(config))
  expect(configuredShadowTemplates).toThrow('storage policy')
  config.storagePolicy.maximumBytes = 100000
  config.planTemplates.push(config.planTemplates[0])
  vi.stubEnv('SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE', JSON.stringify(config))
  expect(configuredShadowTemplates).toThrow('Duplicate')
  expect(openShadowActiveDatabase).not.toHaveBeenCalled()
})
