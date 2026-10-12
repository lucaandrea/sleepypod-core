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
export const waveformRunSchema = z.object({
  version: z.literal('retained-waveform-run-v1'), build_hash: hash, decoded_records: count, raw_records: count,
  counts: z.object({ records: count, accepted_frames: count, empty_channel_frames: count,
    pump_gated_frames: count, preroll_outputs: count, scored_outputs: count }).strict(),
  limitations, config_hashes: z.object({ left: hash, right: hash }).strict(), artifact_hashes: z.array(hash).min(1).max(64),
}).strict()
