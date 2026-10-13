import { packageFixtureSuiteSchema } from './fixtures'
import { runPackagePreflight } from './preflight'
import { readManagedEvidence } from './managed-evidence'
import { managedProtocolSchema } from './managed-protocol'
export { managedProtocolSchema } from './managed-protocol'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { createNightUncertainty } from '../../src/biometrics/backtest/uncertainty-core'
import { verifyAlgorithmPackage } from '../../src/biometrics/packages/manifest'
import { signalFrameSchema } from '../../src/biometrics/packages/protocol'
import { referenceImportSchema } from '../../src/biometrics/references/contracts'
import { previewReferenceImport } from '../../src/biometrics/references/normalize'
import { executePackageExperiment, type ExperimentPolicy } from './container'
import type { PackageExperimentLedger } from './ledger'
import { comparePackageOutputs } from './comparison'
import { assessPackageResources } from './resource-assessment'
import { publishJson } from './files'

interface Variant {
  label: 'default' | 'current' | 'candidate'
  manifest: unknown
  files: ReadonlyMap<string, Uint8Array>
  config: Record<string, unknown>
  seed: number
  policy: ExperimentPolicy
}
const uncertainty = createNightUncertainty(text => createHash('sha256').update(text).digest(), 'equal_night_mean_common_mae_difference')

/** The loader is trusted host code, called only after exposure is committed.
 * It must read retained inputs; no candidate module is loaded on the host. */
export async function runManagedTrial(options: {
  ledger: PackageExperimentLedger
  trialId: string
  protocol: unknown
  preflightSuite?: unknown
  variants: Variant[]
  reportDirectory: string
  publishReport?: typeof publishJson
  loadNight: (id: string) => Promise<{ referenceImport: unknown, frames: () => Iterable<unknown> }>
}) {
  const publishReport = options.publishReport ?? publishJson
  const trial = options.ledger.trial(options.trialId)
  if (trial.state === 'succeeded') {
    const evidence = readManagedEvidence(options.ledger, trial.id, options.reportDirectory)
    return { state: 'already_completed' as const, reportHash: evidence.reportHash }
  }
  const study = options.ledger.study(trial.request.studyId)
  const protocol = managedProtocolSchema.parse(structuredClone(options.protocol))
  if (configHash(protocol) !== study.protocolHash) throw new Error('Managed protocol identity mismatch')
  if (options.variants.length !== 3 || new Set(options.variants.map(variant => variant.label)).size !== 3) throw new Error('Three distinct variants are required')
  const variants = options.variants.map((variant) => {
    const verified = verifyAlgorithmPackage(variant.manifest, variant.files)
    const expected = trial.request.variants.find(item => item.label === variant.label)
    const config = structuredClone(variant.config)
    const seed = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(variant.seed)
    if (!expected || verified.packageHash !== expected.packageHash || configHash({ config, seed }) !== expected.configHash || variant.policy.image !== expected.image) throw new Error('Managed variant identity mismatch')
    return { ...variant, manifest: verified.manifest, packageHash: verified.packageHash, config, seed,
      files: new Map([...variant.files].map(([path, bytes]) => [path, Buffer.from(bytes)])), policy: structuredClone(variant.policy) }
  })
  const candidate = variants.find(variant => variant.label === 'candidate')
  if (protocol.preflightPlan && (!candidate || protocol.preflightPlan.configHash !== configHash({ config: candidate.config, seed: candidate.seed })
    || protocol.preflightPlan.hardwareId !== protocol.hardwareId || protocol.preflightPlan.sampleRateHz !== protocol.sampleRateHz
    || protocol.preflightPlan.side !== study.side)) throw new Error('Managed preflight candidate mismatch')
  if (Boolean(protocol.preflightPlan) !== (options.preflightSuite !== undefined)) throw new Error('Managed preflight plan and suite must be supplied together')
  const preflightSuite = options.preflightSuite === undefined ? undefined : packageFixtureSuiteSchema.parse(structuredClone(options.preflightSuite))
  if (protocol.preflightPlan && dataHash(preflightSuite) !== protocol.preflightPlan.suiteHash) throw new Error('Managed preflight suite mismatch')
  await mkdir(options.reportDirectory, { recursive: true, mode: 0o700 })
  const lease = options.ledger.claim(options.trialId, 30000)
  const controller = new AbortController()
  const heartbeat = setInterval(() => {
    try {
      options.ledger.renew(lease, 30000)
    }
    catch { controller.abort() }
  }, 5000)
  const nights: {
    nightId: string
    reportHash: string
    comparison: ReturnType<typeof comparePackageOutputs>
    resources: { label: Variant['label'], assessment: ReturnType<typeof assessPackageResources> }[]
  }[] = []
  let preflight: { reportHash: string, status: 'failed' | 'incomplete' | 'external_checks_passed' } | undefined
  try {
    if (protocol.preflightPlan && candidate) {
      const report = await runPackagePreflight({ ...candidate, signal: controller.signal }, protocol.preflightPlan, preflightSuite)
      const reportHash = dataHash(report)
      options.ledger.renew(lease, 30000)
      await publishReport(join(options.reportDirectory, `${reportHash}.json`), report)
      preflight = { reportHash, status: report.status }
    }
    for (const night of study.nights.filter(night => night.split === trial.request.split)) {
      controller.signal.throwIfAborted()
      options.ledger.renew(lease, 30000)
      const source = await options.loadNight(night.id)
      const referenceImport = referenceImportSchema.parse(structuredClone(source.referenceImport))
      if (referenceImport.side !== study.side || referenceImport.subjectId !== study.subjectId
        || previewReferenceImport(referenceImport).summary.contentHash !== night.referenceHash) throw new Error('Managed reference identity mismatch')
      const outputs = []
      for (const variant of variants) {
        controller.signal.throwIfAborted()
        options.ledger.renew(lease, 30000)
        const request = { schema: 'biometric-package-run-v1', packageHash: variant.packageHash, inputHash: night.inputHash,
          hardwareId: protocol.hardwareId, sampleRateHz: protocol.sampleRateHz, side: study.side, seed: variant.seed, config: variant.config }
        const frames = function* () {
          for (const input of source.frames()) {
            const frame = signalFrameSchema.parse(input)
            const length = frame.samples[study.side]?.length ?? 0
            if (frame.timestampMs < night.startMs || frame.timestampMs + length * 1000 / protocol.sampleRateHz > night.endMs) throw new Error('Frame outside frozen night')
            yield frame
          }
        }
        const result = await executePackageExperiment({ ...variant, request, frames: frames(), signal: controller.signal })
        outputs.push({ label: variant.label, manifest: variant.manifest, request, result })
      }
      const comparison = comparePackageOutputs({ schema: 'biometric-package-comparison-v1', metricId: protocol.metricId,
        startMs: night.startMs, endMs: night.endMs, minimumQuality: protocol.minimumQuality, referenceImport, alignment: protocol.alignment, outputs })
      const report = { schema: 'biometric-managed-night-v1', trialId: lease.trialId, attemptId: lease.attemptId, night, referenceImport, outputs, comparison,
        resources: outputs.map(output => ({ label: output.label, assessment: assessPackageResources(output.result.execution, protocol.resourcePolicy) })) }
      const reportHash = dataHash(report)
      options.ledger.renew(lease, 30000)
      await publishReport(join(options.reportDirectory, `${reportHash}.json`), report)
      nights.push({ nightId: night.id, reportHash, comparison, resources: report.resources })
    }
    const uncertaintyReports = (['default', 'current'] as const).map(baseline => ({ baseline,
      report: uncertainty(nights.map(night => ({ cohortId: night.nightId,
        difference: night.comparison.comparisons.find(comparison => comparison.candidate === 'candidate' && comparison.baseline === baseline)?.differences.commonMae ?? null })), protocol.uncertainty) }))
    const report = { schema: 'biometric-managed-trial-v1', trialId: lease.trialId, attemptId: lease.attemptId,
      study, protocol, request: trial.request, ...(preflight ? { preflight } : {}), nights, uncertainty: uncertaintyReports, exposureAtClaim: lease,
      interpretation: 'requires_current_ledger_exposure_check_and_full_qualification_review' }
    const reportHash = dataHash(report)
    options.ledger.renew(lease, 30000)
    await publishReport(join(options.reportDirectory, `${reportHash}.json`), report)
    options.ledger.finish(lease, 'succeeded', reportHash)
    return { state: 'succeeded' as const, reportHash, evidence: options.ledger.currentEvidence(lease.trialId) }
  }
  catch (error) {
    controller.abort()
    const report = { schema: 'biometric-managed-trial-failure-v1', trialId: lease.trialId, attemptId: lease.attemptId, ...(preflight ? { preflight } : {}), nights,
      error: error instanceof Error ? error.message.slice(0, 1000) : 'Managed trial failed' }
    const reportHash = dataHash(report)
    let published = false
    const secondaryErrors: unknown[] = []
    try {
      await publishReport(join(options.reportDirectory, `${reportHash}.json`), report)
      published = true
    }
    catch (publicationError) { secondaryErrors.push(publicationError) }
    try {
      // Publication failure must not leave a writable ledger's attempt running.
      // A missing artifact has no report hash. The lease still fences replacement.
      options.ledger.finish(lease, 'failed', published ? reportHash : null)
    }
    catch (ledgerError) { secondaryErrors.push(ledgerError) }
    if (secondaryErrors.length) throw new AggregateError([error, ...secondaryErrors],
      `${error instanceof Error ? error.message : 'Managed trial failed'}; failure evidence incomplete`, { cause: error })
    throw error
  }
  finally { clearInterval(heartbeat) }
}
