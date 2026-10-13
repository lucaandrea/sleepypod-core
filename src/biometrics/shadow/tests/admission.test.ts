// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { dataHash } from '../../algorithms/canonical'
import { manifestHash } from '../../algorithms/registry'
import { installedShadowAdmitter, readInstalledShadowQualifications } from '../admission'
const a = 'a'.repeat(64), b = 'b'.repeat(64), now = 1700000000000
const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-admission-'))
  directories.push(directory)
  const workerPath = join(directory, 'worker.cjs'), file = join(directory, 'shadow-qualifications.json')
  const execution = { version: 'shadow-execution-policy-v1', configHashes: { left: a, right: a },
    maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
    budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 10000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
    leaseMs: 1500, heartbeatMs: 200, sources: { pollMs: 50, maximumActiveRows: 10, databaseBusyTimeoutMs: 50,
      frames: { maximumFrames: 10, maximumBytes: 100000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
      context: { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 4096 } } }
  const entry = { qualificationId: 'reviewed-test-only', manifestHash, engineBuildHash: a, pythonBuildHash: b, hardwareId: 'fixture-hardware', sampleRateHz: 500,
    activeConfigHash: a, executionPolicyHash: dataHash(execution), fixtureEvidenceHash: a, podEvidenceHash: b, heldOutEvidenceHash: a,
    contextEvidence: 'host_observations_not_live_processor_cache_attestation', maximumRuntimeHeartbeatAgeMs: 1000, maximumHardwareObservationAgeMs: 1000,
    healthPolicy: { qualificationId: 'reviewed-test-only', minimumAvailableMemoryBytes: 100, minimumFreeDiskBytes: 100,
      maximumLoadPerCpu: 1, maximumEventLoopDelayMs: 100, maximumPiezoAgeMs: 1000, maximumTemperatureC: 70, maximumSampleAgeMs: 1000 } }
  const plan = { schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'test', execution, startMs: now, endMs: now + 10000,
    candidateConfigHash: a, activeConfigHash: a, engineBuildHash: a, qualificationHash: dataHash(entry), maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 100, drainGraceMs: 500 },
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 1000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }
  const identity = { engineBuildHash: a, pythonBuildHash: b, hardwareId: 'fixture-hardware', sampleRateHz: 500 }
  const binding = { side: 'left', generation: 3, resolvedHash: a, appliedHash: a, appliedGeneration: 3, state: 'applied', heartbeatAtMs: now }
  const health = { measuredAtMs: now, availableMemoryBytes: 1000, freeDiskBytes: 1000, loadPerCpu: 0.1, eventLoopDelayMs: 1, piezoReceivedAtMs: now, temperatureC: 40 }
  const options = { workerPath, expectedBinding: { side: 'left' as const, generation: 3, resolvedHash: a },
    identity: () => identity, binding: () => binding, health: () => health, now: () => now }
  const install = (entries: unknown[] = [entry]) => writeFileSync(file, JSON.stringify({ version: 'biometric-shadow-qualifications-v1', entries }))
  install()
  return { entry, plan, options, identity, binding, health, install, file, workerPath, admit: installedShadowAdmitter(options) }
}
it('admits only an exact installed qualification with applied current binding and fresh health', () => {
  const { admit, plan, binding } = setup()
  expect(admit(plan)).toBeUndefined()
  binding.generation++
  binding.appliedGeneration++
  expect(() => admit(plan)).toThrow(/binding changed/)
})
it.each(['engineBuildHash', 'pythonBuildHash', 'hardwareId', 'sampleRateHz'] as const)('refuses changed installed %s', (field) => {
  const fixture = setup()
  Object.assign(fixture.identity, { [field]: field === 'sampleRateHz' ? 250 : field === 'pythonBuildHash' ? a : b })
  expect(() => fixture.admit(fixture.plan)).toThrow()
})
it.each(['appliedHash', 'appliedGeneration', 'state', 'heartbeatAtMs', 'side'])('refuses invalid runtime %s', (field) => {
  const fixture = setup()
  Object.assign(fixture.binding, { [field]: field === 'appliedGeneration' ? 2 : field === 'heartbeatAtMs' ? now - 1001 : field === 'state' ? 'pending_boundary' : field === 'side' ? 'right' : b })
  expect(() => fixture.admit(fixture.plan)).toThrow()
})
it.each(['availableMemoryBytes', 'freeDiskBytes', 'measuredAtMs', 'piezoReceivedAtMs', 'temperatureC', 'loadPerCpu'])('refuses unhealthy or stale %s', (field) => {
  const fixture = setup()
  Object.assign(fixture.health, { [field]: field.endsWith('Ms') ? now - 1001 : field.endsWith('Bytes') ? 0 : 100 })
  expect(() => fixture.admit(fixture.plan)).toThrow(/admission refused/)
})
it('binds all resource limits and refuses substitution or duplicate qualification entries', () => {
  const { admit, plan, entry, install } = setup()
  plan.execution.budgets.maximumRssBytes++
  expect(() => admit(plan)).toThrow(/installed execution/)
  plan.execution.budgets.maximumRssBytes--
  install([entry, entry])
  expect(() => admit(plan)).toThrow(/ambiguous/)
})
it('reads revocation on subsequent admission instead of caching authorization', () => {
  const { admit, plan, install } = setup()
  admit(plan)
  install([])
  expect(() => admit(plan)).toThrow(/missing/)
})
it.each(['missing', 'oversize', 'symlink', 'malformed'])('rejects a %s installed file', (mode) => {
  const { file, workerPath } = setup()
  if (mode === 'missing') rmSync(file)
  if (mode === 'oversize') writeFileSync(file, 'x'.repeat(256 * 1024 + 1))
  if (mode === 'malformed') writeFileSync(file, '{}')
  if (mode === 'symlink') {
    rmSync(file)
    writeFileSync(file + '.target', '{}')
    symlinkSync(file + '.target', file)
  }
  expect(() => readInstalledShadowQualifications(workerPath)).toThrow(/unavailable/)
})
it('rejects asynchronous host observations without leaking rejected promises', async () => {
  const { options, plan } = setup()
  const admit = installedShadowAdmitter({ ...options, identity: () => Promise.reject(new Error('collector failed')) })
  expect(() => admit(plan)).toThrow(/synchronous/)
  await Promise.resolve()
})
