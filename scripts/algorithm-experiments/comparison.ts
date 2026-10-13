import { z } from 'zod'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { compareNumericConfigurations } from '../../src/biometrics/backtest/numeric-comparison'
import { algorithmPackageManifestSchema } from '../../src/biometrics/packages/manifest'
import { metricFrameSchema, packageRunRequestSchema } from '../../src/biometrics/packages/protocol'
import { referenceCompatibility } from '../../src/biometrics/references/alignment'
import { normalizeReferenceImport } from '../../src/biometrics/references/normalize-core'
import { referenceImportSchema, timestampMsSchema } from '../../src/biometrics/references/contracts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const packageComparisonInputSchema = z.object({
  schema: z.literal('biometric-package-comparison-v1'), metricId: z.string().min(1).max(100),
  startMs: timestampMsSchema, endMs: timestampMsSchema, minimumQuality: z.number().min(0).max(1),
  referenceImport: referenceImportSchema,
  alignment: z.object({ version: z.literal('reference-alignment-v1'), pointToleranceMs: z.number().int().min(0).max(300000),
    clockOffsetMs: z.number().int().min(-3600000).max(3600000), offsetSource: z.enum(['fixed', 'training']) }).strict(),
  outputs: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']), manifest: algorithmPackageManifestSchema,
    request: packageRunRequestSchema,
    result: z.object({ packageHash: hash, runHash: hash,
      frozenInput: z.object({ schema: z.literal('biometric-package-input-v1'), hash, bytes: z.number().int().positive(), frameCount: z.number().int().positive() }).strict(),
      results: z.array(metricFrameSchema).max(100000),
    }),
  }).strict()).length(3),
}).strict().refine(value => value.endMs > value.startMs && value.endMs - value.startMs <= 86400000, 'Comparison requires a bounded whole-night interval')

/** Descriptive scoring of host-produced experiment reports. This does not
 * attest execution provenance or independent holdout use; promotion must use
 * the authoritative experiment store and reviewed qualification pipeline. */
export function comparePackageOutputs(raw: unknown) {
  const input = packageComparisonInputSchema.parse(raw)
  if (new Set(input.outputs.map(output => output.label)).size !== 3) throw new Error('Default, current and candidate outputs are required')
  const reference = normalizeReferenceImport(input.referenceImport)
  let commonInput: string | undefined
  let frameIdentity: string | undefined
  let contract: { metric: 'heart_rate' | 'breathing_rate' | 'window_ibi_variability_v1' | 'hrv_rmssd' | 'hrv_sdnn', windowMs: number | null } | undefined
  const outputs = input.outputs.map((output) => {
    const { manifest, request, result } = output
    const packageHash = configHash(manifest)
    if (packageHash !== request.packageHash || packageHash !== result.packageHash || configHash(request) !== result.runHash
      || result.frozenInput.hash !== request.inputHash || result.frozenInput.frameCount !== result.results.length) throw new Error('Package comparison identity mismatch')
    if (request.side !== input.referenceImport.side) throw new Error('Reference side mismatch')
    const identity = configHash({ inputHash: request.inputHash, side: request.side, hardwareId: request.hardwareId, sampleRateHz: request.sampleRateHz })
    if (commonInput !== undefined && commonInput !== identity) throw new Error('Packages did not process the same input and side')
    commonInput = identity
    const frameHash = dataHash(result.results.map(frame => frame.frameHash))
    if (frameIdentity !== undefined && frameIdentity !== frameHash) throw new Error('Packages received different frames')
    frameIdentity = frameHash
    const metric = manifest.metrics.find(metric => metric.id === input.metricId)
    if (!metric?.reference) throw new Error('Package lacks a comparable metric contract')
    if (contract && configHash(contract) !== configHash(metric.reference)) throw new Error('Incompatible package metric definitions or windows')
    contract = metric.reference
    const observations = []
    for (const [index, frame] of result.results.entries()) {
      if (frame.runHash !== result.runHash || frame.sequence !== index) throw new Error('Package output identity mismatch')
      for (const reading of frame.readings) {
        if (reading.side !== request.side) throw new Error('Package output side mismatch')
        if (reading.metric !== input.metricId) continue
        if (reading.value !== null && (reading.value < metric.minimum || reading.value > metric.maximum)) throw new Error('Package metric outside declared range')
        if (reading.timestampMs >= input.startMs && reading.timestampMs < input.endMs) observations.push({ timestampMs: reading.timestampMs, value: reading.quality >= input.minimumQuality ? reading.value : null })
      }
    }
    return { label: output.label, configHash: result.runHash, observations }
  })
  if (!contract) throw new Error('No comparable metric contract')
  const selected = reference.measurements.filter(row => row.startMs >= input.startMs && row.startMs < input.endMs && row.endMs <= input.endMs)
  const compatibilityExclusions: Record<string, number> = {}
  for (const row of selected) {
    const reason = referenceCompatibility(contract.metric, contract.windowMs, row)
    if (reason) compatibilityExclusions[reason] = (compatibilityExclusions[reason] ?? 0) + 1
  }
  const comparisons = compareNumericConfigurations(contract.metric, contract.windowMs, outputs, selected, input.alignment)
  return { schema: 'biometric-package-comparison-report-v1' as const, inputHash: dataHash(input), referenceHash: dataHash(reference.measurements),
    metricId: input.metricId, contract, alignment: input.alignment, startMs: input.startMs, endMs: input.endMs,
    minimumQuality: input.minimumQuality, excludedBoundaryReferences: reference.measurements.length - selected.length, compatibilityExclusions,
    referenceSummary: reference.summary, comparisons, interpretation: 'descriptive_reference_agreement_not_independent_holdout_or_promotion_evidence' as const }
}
