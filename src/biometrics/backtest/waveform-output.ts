import { z } from 'zod'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const side = z.enum(['left', 'right'])
const value = z.number().finite().nullable()
const limitations = z.array(z.string().max(200)).max(40)
export const waveformReadingSchema = z.object({
  side, timestampMs: count, heartRate: value, hrvIndex: value,
  hrvMetric: z.literal('window_ibi_variability_v1'), breathingRate: value,
  qualityScore: z.number().finite(), flags: z.array(z.string().max(200)).max(40).nullable(), hrRaw: value,
  sourceSide: side, configHash: hash, limitations,
}).strict()
/** Optional only for retained reports produced before resource collection.
 * These are one Python process's costs, not whole-job or live-ingestion costs. */
export const waveformProcessResourcesSchema = z.object({
  version: z.literal('waveform-process-resources-v1'),
  wallMs: z.number().finite().nonnegative(), cpuMs: z.number().finite().nonnegative(),
  peakRssBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  scope: z.literal('python_process_until_result'), memoryScope: z.literal('process_lifetime_high_water_mark'),
}).strict()
export const waveformRunSchema = z.object({
  resources: waveformProcessResourcesSchema.optional(),
  version: z.literal('retained-waveform-run-v1'), build_hash: hash, decoded_records: count, raw_records: count,
  counts: z.object({ records: count, accepted_frames: count, empty_channel_frames: count,
    pump_gated_frames: count, preroll_outputs: count, scored_outputs: count }).strict(),
  limitations, config_hashes: z.object({ left: hash, right: hash }).strict(), artifact_hashes: z.array(hash).min(1).max(64),
}).strict()

export const waveformEvaluationSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), outputs: z.array(z.object({
  cohortId: z.string().min(1).max(200), configHash: z.string().regex(/^[a-f0-9]{64}$/),
  readings: z.array(waveformReadingSchema).max(20000), run: waveformRunSchema,
}).strict()).max(180) }).strict().refine(value => value.outputs.reduce((sum, output) => sum + output.readings.length, 0) <= 20000, 'Waveform reading budget exceeded')
