// @vitest-environment node
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it } from 'vitest'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { previewReferenceImport } from '../../src/biometrics/references/normalize'
import { packageFixture } from '../../src/biometrics/packages/tests/fixture'
import { inspectPythonEnvironment } from './environment'
import { packageInputHash } from './input'
import { PackageExperimentLedger } from './ledger'
import { runManagedFiles } from './managed-files'
import { runManagedTrial } from './managed'
import { readManagedEvidence } from './managed-evidence'
import { fixtureResourceTestPolicy } from './resource-test-policy'
const image = process.env.BIOMETRIC_EXPERIMENT_TEST_IMAGE
let environmentBytes: Buffer<ArrayBuffer>
beforeAll(async () => {
  if (image) environmentBytes = Buffer.from(JSON.stringify(await inspectPythonEnvironment(image)))
})
const start = 1791673200000
function fixture(ledger: PackageExperimentLedger) {
  const { manifest, files } = packageFixture()
  const code = `import json, sys
init = json.loads(sys.stdin.readline())
for line in sys.stdin:
    msg = json.loads(line)
    frame = msg['frame']
    print(json.dumps({'schema': 'biometric-metric-frame-v1', 'runHash': init['runHash'], 'frameHash': msg['frameHash'], 'sequence': frame['sequence'], 'state': {}, 'readings': [{'timestampMs': frame['timestampMs'], 'side': 'left', 'metric': 'heart_rate', 'value': 60 + init['request']['config']['offset'], 'quality': 1, 'flags': []}]}), flush=True)
`
  files.set('engine.py', Buffer.from(code))
  files.set(manifest.dependencyLock, environmentBytes)
  const declared = { ...manifest, metrics: manifest.metrics.map(metric => ({ ...metric, reference: { metric: 'heart_rate', windowMs: null } })),
    resources: { cpuMs: 5000, wallMs: 5000, memoryBytes: 64 * 1024 * 1024, processes: 1, outputBytes: 16384 },
    artifacts: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) }
  const frames = [0, 1].map(sequence => ({ schema: 'biometric-signal-frame-v1', sequence, timestampMs: start + sequence * 1000,
    samples: { left: [1, 2, 3], right: null }, context: { occupied: true, pumpActive: false } }))
  const referenceImport = { side: 'left' as const, subjectId: 'fixture', source: 'synthetic', rows: [0, 1].map(index => ({ recordKey: String(index), metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: start + index * 1000 })) }
  const protocol = { schema: 'biometric-managed-protocol-v1', hardwareId: 'pod4', sampleRateHz: 500, metricId: 'heart_rate', minimumQuality: 0.8,
    alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' },
    uncertainty: { version: 'paired-night-percentile-v1', seed: 'fixture', resamples: 200, minimumNights: 3 }, resourcePolicy: fixtureResourceTestPolicy }
  const study = ledger.createStudy({ schema: 'biometric-package-study-v1', subjectId: 'fixture', side: 'left', protocolHash: configHash(protocol),
    nights: [{ id: 'night', startMs: start, endMs: start + 120000, inputHash: packageInputHash(frames), referenceHash: previewReferenceImport(referenceImport).summary.contentHash, split: 'holdout' }] })
  const variants = (['default', 'current', 'candidate'] as const).map((label, index) => ({ label, manifest: declared, files,
    config: { offset: 4 - index * 2 }, seed: 1,
    policy: { image: image ?? '', maximumWallMs: 10000, maximumMemoryBytes: 128 * 1024 * 1024, maximumProcesses: 4, maximumOutputBytes: 32768, maximumInputBytes: 32768 } }))
  const request = { studyId: study.id, split: 'holdout', variants: variants.map(variant => ({ label: variant.label, packageHash: configHash(declared),
    configHash: configHash({ config: variant.config, seed: variant.seed }), image: variant.policy.image })) }
  return { trialId: ledger.reserveTrial(request, 'first'), request, protocol, variants, referenceImport, frames }
}
describe.skipIf(!image)('managed package trials through real Docker', () => {
  it('records exposure before loading, compares all variants, publishes verified artifacts and reuses completion', async () => {
    const db = new Database(':memory:'), root = await mkdtemp(join(tmpdir(), 'managed-trial-test-'))
    try {
      const ledger = new PackageExperimentLedger(db)
      const input = fixture(ledger)
      let loads = 0
      const options = { ...input, ledger, reportDirectory: root, loadNight: async () => {
        loads++
        expect(ledger.trial(input.trialId).state).toBe('running')
        expect((db.prepare('SELECT COUNT(*) AS count FROM package_exposures').get() as { count: number }).count).toBe(1)
        return { referenceImport: input.referenceImport, frames: () => input.frames }
      } }
      const result = await runManagedTrial(options)
      expect(result).toMatchObject({ state: 'succeeded', evidence: { uniqueHoldoutAttempt: true } })
      const report = JSON.parse(await readFile(join(root, `${result.reportHash}.json`), 'utf8'))
      expect(dataHash(report)).toBe(result.reportHash)
      expect(report.uncertainty.map((row: { report: { estimate: number } }) => row.report.estimate)).toEqual([-4, -2])
      const night = JSON.parse(await readFile(join(root, `${report.nights[0].reportHash}.json`), 'utf8'))
      expect(dataHash(night)).toBe(report.nights[0].reportHash)
      expect(night.outputs).toHaveLength(3)
      expect(await runManagedTrial(options)).toEqual({ state: 'already_completed', reportHash: result.reportHash })
      expect(loads).toBe(1)
      expect(readManagedEvidence(ledger, input.trialId, root)).toMatchObject({
        reportHash: result.reportHash, currentEvidence: { uniqueHoldoutAttempt: true },
      })
      // A valid top-level hash does not excuse a missing or corrupted child.
      const childPath = join(root, `${report.nights[0].reportHash}.json`)
      await rm(childPath)
      await expect(runManagedTrial(options)).rejects.toThrow()
      await writeFile(childPath, JSON.stringify({ ...night, outputs: [] }))
      await expect(runManagedTrial(options)).rejects.toThrow('integrity mismatch')
      await writeFile(childPath, JSON.stringify(night))
      // Even a rehashed report graph cannot substitute a derived score. The
      // verifier recomputes from the retained outputs and frozen protocol.
      const forgedChild = structuredClone(night)
      forgedChild.comparison.comparisons[0].differences.commonMae = -999
      const forgedChildHash = dataHash(forgedChild)
      await writeFile(join(root, `${forgedChildHash}.json`), JSON.stringify(forgedChild))
      const forged = structuredClone(report)
      forged.nights[0].reportHash = forgedChildHash
      forged.nights[0].comparison = forgedChild.comparison
      const forgedHash = dataHash(forged)
      await writeFile(join(root, `${forgedHash}.json`), JSON.stringify(forged))
      db.prepare('UPDATE package_trials SET report_hash = ? WHERE id = ?').run(forgedHash, input.trialId)
      expect(() => readManagedEvidence(ledger, input.trialId, root)).toThrow('night comparison integrity')
      // Retained request/uncertainty substitutions are rejected independently.
      for (const replacement of [{ ...report, uncertainty: [] }, { ...report, request: { ...report.request, split: 'tuning' } }]) {
        const replacementHash = dataHash(replacement)
        await writeFile(join(root, `${replacementHash}.json`), JSON.stringify(replacement))
        db.prepare('UPDATE package_trials SET report_hash = ? WHERE id = ?').run(replacementHash, input.trialId)
        expect(() => readManagedEvidence(ledger, input.trialId, root)).toThrow('integrity mismatch')
      }
      db.prepare('UPDATE package_trials SET report_hash = ? WHERE id = ?').run(result.reportHash, input.trialId)
      await writeFile(join(root, `${result.reportHash}.json`), JSON.stringify({ ...report, trialId: 'changed' }))
      await expect(runManagedTrial(options)).rejects.toThrow('integrity mismatch')
      expect(loads).toBe(1)
      await writeFile(join(root, `${result.reportHash}.json`), JSON.stringify(report))
      const second = ledger.reserveTrial(input.request, 'second')
      ledger.claim(second, 30000)
      expect(ledger.currentEvidence(input.trialId).uniqueHoldoutAttempt).toBe(false)
      expect(readManagedEvidence(ledger, input.trialId, root).currentEvidence.uniqueHoldoutAttempt).toBe(false)
      expect(loads).toBe(1)
    }
    finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
  it('runs a managed descriptor through persistent storage and reuses it without reopening night files', async () => {
    const db = new Database(':memory:'), root = await mkdtemp(join(tmpdir(), 'managed-files-test-'))
    try {
      const ledger = new PackageExperimentLedger(db), input = fixture(ledger)
      const variant = input.variants[0]
      const proposal = { schema: 'biometric-package-proposal-v1', manifest: variant.manifest,
        files: [...variant.files].map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })) }
      const descriptor = { schema: 'biometric-managed-descriptor-v1', study: ledger.study(input.request.studyId), protocol: input.protocol,
        split: 'holdout', idempotencyKey: 'managed-files',
        variants: input.variants.map(variant => ({ label: variant.label, proposal: 'proposal.json', config: variant.config, seed: variant.seed, policy: variant.policy })),
        nights: [{ id: 'night', frames: 'frames.jsonl', referenceImport: 'references.json' }] }
      await writeFile(join(root, 'proposal.json'), JSON.stringify(proposal))
      await writeFile(join(root, 'descriptor.json'), JSON.stringify(descriptor))
      await writeFile(join(root, 'references.json'), JSON.stringify(input.referenceImport))
      await writeFile(join(root, 'frames.jsonl'), input.frames.map(frame => JSON.stringify(frame)).join('\n'))
      const workspace = join(root, 'workspace')
      const first = await runManagedFiles(workspace, join(root, 'descriptor.json'))
      expect(first).toMatchObject({ state: 'succeeded', currentEvidence: { uniqueHoldoutAttempt: true } })
      expect((await stat(join(workspace, 'experiments.sqlite'))).mode & 0o777).toBe(0o600)
      expect(dataHash(JSON.parse(await readFile(first.reportFile, 'utf8')))).toBe(first.reportHash)
      await rm(join(root, 'frames.jsonl'))
      await rm(join(root, 'references.json'))
      const repeated = await runManagedFiles(workspace, join(root, 'descriptor.json'))
      expect(repeated).toMatchObject({ state: 'already_completed', trialId: first.trialId, reportHash: first.reportHash })
      descriptor.variants[2].config.offset++
      await writeFile(join(root, 'descriptor.json'), JSON.stringify(descriptor))
      await expect(runManagedFiles(workspace, join(root, 'descriptor.json'))).rejects.toThrow('idempotency conflict')
    }
    finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
  it('refuses publication after its lease expires while loading retained input', async () => {
    const db = new Database(':memory:'), root = await mkdtemp(join(tmpdir(), 'managed-trial-stale-'))
    let now = 1000
    try {
      const ledger = new PackageExperimentLedger(db, () => now), input = fixture(ledger)
      await expect(runManagedTrial({ ...input, ledger, reportDirectory: root, loadNight: async () => {
        now += 30000
        return { referenceImport: input.referenceImport, frames: () => input.frames }
      } })).rejects.toThrow('Stale trial lease')
      expect(ledger.trial(input.trialId).report_hash).toBeNull()
      expect(ledger.claim(input.trialId, 30000).unexposedHoldoutAtClaim).toBe(false)
    }
    finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('fails substituted references after recording access and preserves failure evidence', async () => {
    const db = new Database(':memory:'), root = await mkdtemp(join(tmpdir(), 'managed-trial-failure-'))
    try {
      const ledger = new PackageExperimentLedger(db), input = fixture(ledger)
      await expect(runManagedTrial({ ...input, ledger, reportDirectory: root, loadNight: async () => ({
        referenceImport: { ...input.referenceImport, source: 'changed' }, frames: () => input.frames,
      }) })).rejects.toThrow('reference identity')
      const trial = ledger.trial(input.trialId)
      expect(trial.state).toBe('failed')
      const report = JSON.parse(await readFile(join(root, `${trial.report_hash}.json`), 'utf8'))
      expect(dataHash(report)).toBe(trial.report_hash)
      expect(ledger.claim(input.trialId, 30000).unexposedHoldoutAtClaim).toBe(false)
    }
    finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
