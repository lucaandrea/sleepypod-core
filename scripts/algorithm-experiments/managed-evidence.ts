import { verifyPreflightEvidence } from './preflight-evidence'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { createNightUncertainty } from '../../src/biometrics/backtest/uncertainty-core'
import { previewReferenceImport } from '../../src/biometrics/references/normalize'
import { comparePackageOutputs, packageComparisonInputSchema } from './comparison'
import { readJsonFile } from './files'
import { packageStudySchema, type PackageExperimentLedger } from './ledger'
import { managedProtocolSchema } from './managed-protocol'
import { assessPackageResources } from './resource-assessment'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const summarySchema = z.object({ nightId: z.string(), reportHash: hash, comparison: z.unknown(), resources: z.unknown() }).strict()
const trialSchema = z.object({ schema: z.literal('biometric-managed-trial-v1'), trialId: z.string().uuid(), attemptId: z.string().uuid(),
  study: packageStudySchema, protocol: managedProtocolSchema, request: z.unknown(), nights: z.array(summarySchema).min(1).max(60),
  preflight: z.object({ reportHash: hash, status: z.enum(['failed', 'incomplete', 'external_checks_passed']) }).strict().optional(),
  uncertainty: z.unknown(), exposureAtClaim: z.unknown(),
  interpretation: z.literal('requires_current_ledger_exposure_check_and_full_qualification_review'),
}).strict()
const outputSchema = packageComparisonInputSchema.shape.outputs.element
const nightSchema = z.object({ schema: z.literal('biometric-managed-night-v1'), trialId: z.string().uuid(), attemptId: z.string().uuid(),
  night: packageStudySchema.shape.nights.element, referenceImport: packageComparisonInputSchema.shape.referenceImport,
  outputs: z.array(outputSchema.extend({ result: outputSchema.shape.result.extend({ execution: z.object({
    image: z.string(), limits: z.unknown(), measurements: z.unknown(), wallMs: z.unknown(),
  }).passthrough() }).passthrough() })).length(3), comparison: z.unknown(), resources: z.unknown(),
}).strict()
const uncertainty = createNightUncertainty(text => createHash('sha256').update(text).digest(), 'equal_night_mean_common_mae_difference')
function retained(directory: string, identity: string) {
  hash.parse(identity)
  const value = readJsonFile(join(directory, `${identity}.json`), 32 * 1024 * 1024)
  if (dataHash(value) !== identity) throw new Error('Retained trial report integrity mismatch')
  return value
}
function same(actual: unknown, expected: unknown, description: string) {
  if (dataHash(actual) !== dataHash(expected)) throw new Error(`Retained ${description} integrity mismatch`)
}

/** Verifies the ledger-selected report graph without reopening night inputs or
 * executing candidate code. Derived scores are recomputed, never accepted from
 * the summary. This is an evidence snapshot, not an installation approval. */
export function readManagedEvidence(ledger: PackageExperimentLedger, trialId: string, directory: string) {
  const trial = ledger.trial(trialId)
  if (trial.state !== 'succeeded' || !trial.report_hash) throw new Error('Trial has no successful retained evidence')
  const report = trialSchema.parse(retained(directory, trial.report_hash))
  if (report.trialId !== trial.id || report.attemptId !== trial.attempt_id) throw new Error('Retained trial report identity mismatch')
  const study = ledger.study(trial.request.studyId)
  same(report.study, study, 'study')
  same(report.request, trial.request, 'request')
  if (configHash(report.protocol) !== study.protocolHash) throw new Error('Retained protocol integrity mismatch')
  let preflight: ReturnType<typeof verifyPreflightEvidence> | null = null
  if (report.protocol.preflightPlan) {
    const plan = report.protocol.preflightPlan
    const candidate = trial.request.variants.find(variant => variant.label === 'candidate')
    if (!candidate || !report.preflight || plan.configHash !== candidate.configHash || plan.side !== study.side
      || plan.hardwareId !== report.protocol.hardwareId || plan.sampleRateHz !== report.protocol.sampleRateHz) throw new Error('Retained preflight binding mismatch')
    preflight = verifyPreflightEvidence(retained(directory, report.preflight.reportHash), { plan, packageHash: candidate.packageHash, image: candidate.image })
    same(preflight.status, report.preflight.status, 'preflight status')
  }
  else if (report.preflight) throw new Error('Unexpected retained preflight evidence')
  const selected = study.nights.filter(night => night.split === trial.request.split)
  if (report.nights.length !== selected.length || new Set(report.nights.map(night => night.nightId)).size !== selected.length
    || selected.some(night => !report.nights.some(row => row.nightId === night.id))) throw new Error('Retained night set integrity mismatch')
  const nights = report.nights.map((summary) => {
    const night = nightSchema.parse(retained(directory, summary.reportHash))
    const expected = selected.find(row => row.id === summary.nightId)
    same(night.night, expected, 'night')
    if (night.trialId !== trial.id || night.attemptId !== trial.attempt_id) throw new Error('Retained night attempt integrity mismatch')
    if (night.referenceImport.side !== study.side || night.referenceImport.subjectId !== study.subjectId
      || previewReferenceImport(night.referenceImport).summary.contentHash !== night.night.referenceHash) throw new Error('Retained reference integrity mismatch')
    for (const output of night.outputs) {
      const variant = trial.request.variants.find(row => row.label === output.label)
      if (!variant || output.request.packageHash !== variant.packageHash
        || configHash({ config: output.request.config, seed: output.request.seed }) !== variant.configHash
        || output.request.inputHash !== night.night.inputHash || output.request.side !== study.side
        || output.request.hardwareId !== report.protocol.hardwareId || output.request.sampleRateHz !== report.protocol.sampleRateHz
        || output.result.execution.image !== variant.image) throw new Error('Retained variant integrity mismatch')
      same(output.result.execution.limits, output.manifest.resources, 'resource limits')
    }
    const comparison = comparePackageOutputs({ schema: 'biometric-package-comparison-v1', metricId: report.protocol.metricId,
      startMs: night.night.startMs, endMs: night.night.endMs, minimumQuality: report.protocol.minimumQuality,
      referenceImport: night.referenceImport, alignment: report.protocol.alignment, outputs: night.outputs })
    const resources = night.outputs.map(output => ({ label: output.label, assessment: assessPackageResources(output.result.execution, report.protocol.resourcePolicy) }))
    same(night.comparison, comparison, 'night comparison')
    same(summary.comparison, comparison, 'summary comparison')
    same(night.resources, resources, 'night resources')
    same(summary.resources, resources, 'summary resources')
    return { nightId: summary.nightId, reportHash: summary.reportHash, comparison, resources }
  })
  const uncertaintyReports = (['default', 'current'] as const).map(baseline => ({ baseline,
    report: uncertainty(nights.map(night => ({ cohortId: night.nightId,
      difference: night.comparison.comparisons.find(row => row.candidate === 'candidate' && row.baseline === baseline)?.differences.commonMae ?? null })), report.protocol.uncertainty) }))
  same(report.uncertainty, uncertaintyReports, 'uncertainty')
  const currentEvidence = ledger.currentEvidence(trialId)
  if (currentEvidence.state !== 'succeeded' || currentEvidence.reportHash !== trial.report_hash) throw new Error('Trial changed during evidence verification')
  return { schema: 'biometric-managed-evidence-v1' as const, trialId, reportHash: trial.report_hash,
    study, protocol: report.protocol, request: trial.request, preflight, nights, uncertainty: uncertaintyReports, currentEvidence,
    interpretation: 'verified_retained_evidence_requires_full_qualification_and_review' as const }
}
