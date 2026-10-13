import { createHash } from 'node:crypto'
import { z } from 'zod'
import { configHash } from '../algorithms/canonical'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/)
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const relativePath = z.string().min(1).max(240).refine(path =>
  path.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part)), 'Expected a relative package file path')
const artifactSchema = z.object({ path: relativePath, sha256: hash, bytes: positiveInteger }).strict()
const referenceContractSchema = z.object({
  metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1', 'hrv_rmssd', 'hrv_sdnn']),
  windowMs: z.number().int().positive().max(86400000).nullable(),
}).strict().refine(value => !['window_ibi_variability_v1', 'hrv_rmssd', 'hrv_sdnn'].includes(value.metric) || value.windowMs !== null, 'HRV comparison requires an explicit window')
const metricSchema = z.object({
  id: identifier, definition: z.string().min(1).max(2000), unit: z.string().min(1).max(80),
  minimum: z.number().finite(), maximum: z.number().finite(),
  reference: referenceContractSchema.optional(),
}).strict().refine(metric => metric.minimum < metric.maximum, 'Metric bounds must be ordered')
  .refine(metric => !metric.reference || metric.unit === (metric.reference.metric === 'heart_rate' ? 'bpm' : metric.reference.metric === 'breathing_rate' ? 'breaths/min' : 'ms'), 'Reference metric requires canonical units')

/** Inert proposal metadata. Passing this schema grants no execution or installation rights. */
export const algorithmPackageManifestSchema = z.object({
  schema: z.literal('biometric-algorithm-package-v1'),
  canonicalization: z.literal('finite-binary64-json-v1'),
  engine: z.object({ id: identifier, version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
  runtime: z.literal('python-frame-v1'), entrypoint: relativePath,
  inputSchema: z.literal('biometric-signal-frame-v1'), outputSchema: z.literal('biometric-metric-frame-v1'),
  metrics: z.array(metricSchema).min(1).max(16),
  hardware: z.array(z.object({ id: identifier, sampleRatesHz: z.array(positiveInteger).min(1).max(16) }).strict()).min(1).max(16),
  temporal: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('causal'), lookaheadMs: z.literal(0) }).strict(),
    z.object({ mode: z.literal('retrospective'), lookaheadMs: positiveInteger }).strict(),
  ]),
  state: z.object({
    schemaId: identifier, initialization: z.literal('explicit_seed_and_config'),
    reset: z.literal('reset_before_each_independent_run'), serialization: z.literal('json'), maximumBytes: positiveInteger,
  }).strict(),
  resources: z.object({
    cpuMs: positiveInteger, wallMs: positiveInteger, memoryBytes: positiveInteger,
    processes: positiveInteger, outputBytes: positiveInteger,
  }).strict(),
  dependencyLock: relativePath,
  artifacts: z.array(artifactSchema).min(2).max(128),
}).strict().superRefine((value, context) => {
  const unique = (values: (string | number)[], label: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: `Duplicate ${label}` })
  }
  unique(value.metrics.map(metric => metric.id), 'metric')
  unique(value.hardware.map(hardware => hardware.id), 'hardware')
  for (const hardware of value.hardware) unique(hardware.sampleRatesHz, 'sample rate')
  unique(value.artifacts.map(artifact => artifact.path), 'artifact path')
  for (const path of [value.entrypoint, value.dependencyLock]) {
    if (!value.artifacts.some(artifact => artifact.path === path)) context.addIssue({ code: 'custom', message: `Unhashed package file: ${path}` })
  }
  if (value.entrypoint === value.dependencyLock) context.addIssue({ code: 'custom', message: 'Entrypoint and dependency lock must be separate files' })
})
export type AlgorithmPackageManifest = z.infer<typeof algorithmPackageManifestSchema>

/** Bounded byte inputs, deliberately with no filesystem paths, imports, or subprocesses.
 * Callers must bound transport size before buffering. These limits are proposal intake
 * limits, not evidence that an algorithm fits the pod's runtime budget. */
export const maximumPackageBytes = 32 * 1024 * 1024
export function verifyAlgorithmPackage(manifestInput: unknown, files: ReadonlyMap<string, Uint8Array>) {
  const manifest = algorithmPackageManifestSchema.parse(manifestInput)
  if (files.size !== manifest.artifacts.length) throw new Error('Package file set differs from manifest')
  const totalBytes = manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumPackageBytes) throw new Error('Package exceeds intake byte limit')
  for (const artifact of manifest.artifacts) {
    const bytes = files.get(artifact.path)
    if (!bytes || bytes.byteLength !== artifact.bytes) throw new Error(`Package file size mismatch: ${artifact.path}`)
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error(`Package file hash mismatch: ${artifact.path}`)
  }
  return { manifest, packageHash: configHash(manifest), totalBytes, status: 'inert_proposal' as const }
}
