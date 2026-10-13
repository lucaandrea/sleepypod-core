import { z } from 'zod'
import { canonicalJson, configHash, dataHash } from '../algorithms/canonical'
import { algorithmPackageManifestSchema } from './manifest'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const side = z.enum(['left', 'right'])
const samples = z.array(z.number().finite()).min(1).max(4096)
export const packageRunRequestSchema = z.object({
  schema: z.literal('biometric-package-run-v1'), packageHash: hash, inputHash: hash,
  hardwareId: z.string().min(1).max(100), sampleRateHz: z.number().int().positive(), side,
  seed: integer, config: z.record(z.string(), z.unknown()),
}).strict()
export const signalFrameSchema = z.object({
  schema: z.literal('biometric-signal-frame-v1'), sequence: integer, timestampMs: time,
  samples: z.object({ left: samples.nullable(), right: samples.nullable() }).strict(),
  context: z.object({ occupied: z.boolean().nullable(), pumpActive: z.boolean().nullable() }).strict(),
}).strict().refine(frame => frame.samples.left !== null || frame.samples.right !== null, 'Frame must contain samples')
  .refine(frame => !frame.samples.left || !frame.samples.right || frame.samples.left.length === frame.samples.right.length, 'Channel lengths differ')
export const metricFrameSchema = z.object({
  schema: z.literal('biometric-metric-frame-v1'), runHash: hash, frameHash: hash, sequence: integer,
  readings: z.array(z.object({
    timestampMs: time, side, metric: z.string().min(1).max(100), value: z.number().finite().nullable(),
    quality: z.number().min(0).max(1), flags: z.array(z.string().min(1).max(100)).max(32),
  }).strict()).max(256),
  state: z.unknown(),
}).strict()

/** Host-side validation of a streaming exchange. This class never runs a package.
 * One validator belongs to one independent run and starts at sequence zero.
 * The executor must send only the current frame, after resetting package state. */
export class PackageFrameValidator {
  readonly manifest
  readonly request
  readonly runHash: string
  private nextSequence = 0
  private outputBytes = 0
  private nextInputTime = 0
  private firstInputTime: number | null = null
  private lastReadingTimes = new Map<string, number>()

  constructor(manifestInput: unknown, requestInput: unknown) {
    this.manifest = algorithmPackageManifestSchema.parse(manifestInput)
    this.request = packageRunRequestSchema.parse(requestInput)
    if (this.request.packageHash !== configHash(this.manifest)) throw new Error('Package identity mismatch')
    const hardware = this.manifest.hardware.find(item => item.id === this.request.hardwareId)
    if (!hardware?.sampleRatesHz.includes(this.request.sampleRateHz)) throw new Error('Unsupported hardware or sample rate')
    // Canonical hashing also rejects non-JSON config values and bounds complexity.
    this.runHash = configHash(this.request)
  }

  validateFrame(frameInput: unknown) {
    const frame = signalFrameSchema.parse(frameInput)
    if (frame.sequence !== this.nextSequence || frame.timestampMs < this.nextInputTime) throw new Error('Out-of-order or overlapping frame')
    const channel = frame.samples[this.request.side]
    if (!channel) throw new Error('Requested side has no samples')
    const endMs = frame.timestampMs + channel.length * 1000 / this.request.sampleRateHz
    if (!Number.isFinite(endMs) || endMs > Number.MAX_SAFE_INTEGER) throw new Error('Frame end exceeds timestamp range')
    return { frame, endMs }
  }

  validateStep(frameInput: unknown, resultInput: unknown) {
    const { frame, endMs } = this.validateFrame(frameInput)
    const result = metricFrameSchema.parse(resultInput)
    if (result.runHash !== this.runHash || result.frameHash !== dataHash(frame) || result.sequence !== frame.sequence) throw new Error('Output identity mismatch')
    // A transport must additionally cap stdout before buffering/parsing it.
    const outputBytes = this.outputBytes + Buffer.byteLength(canonicalJson(result))
    if (outputBytes > this.manifest.resources.outputBytes) throw new Error('Output byte limit exceeded')
    if (Buffer.byteLength(canonicalJson(result.state)) > this.manifest.state.maximumBytes) throw new Error('State byte limit exceeded')
    const firstInputTime = this.firstInputTime ?? frame.timestampMs
    const lastTimes = new Map(this.lastReadingTimes)
    for (const reading of result.readings) {
      const metric = this.manifest.metrics.find(item => item.id === reading.metric)
      if (!metric || reading.side !== this.request.side) throw new Error('Undeclared metric or side')
      if (reading.value !== null && (reading.value < metric.minimum || reading.value > metric.maximum)) throw new Error('Metric outside declared range')
      // A retrospective reading may lag the latest available sample by its
      // declared lookahead. No output may refer to unavailable future samples.
      const latestSampleMs = endMs - 1000 / this.request.sampleRateHz
      if (reading.timestampMs < firstInputTime || reading.timestampMs + this.manifest.temporal.lookaheadMs > latestSampleMs) throw new Error('Reading outside observed time range')
      if (reading.timestampMs <= (lastTimes.get(reading.metric) ?? -1)) throw new Error('Duplicate or out-of-order reading')
      lastTimes.set(reading.metric, reading.timestampMs)
    }
    // A rejected response leaves the sequence and watermarks unchanged.
    this.outputBytes = outputBytes
    this.nextSequence++
    this.nextInputTime = endMs
    this.firstInputTime = firstInputTime
    this.lastReadingTimes = lastTimes
    return { frame, result, endMs }
  }
}
