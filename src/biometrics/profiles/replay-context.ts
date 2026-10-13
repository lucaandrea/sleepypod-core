import { z } from 'zod'
import { waveformEvaluationSchema } from '../backtest/waveform-output'
import { dataHash } from '../algorithms/canonical'
import { ReferenceInputError } from '../references/time'

const limitation = z.enum(['event_time_replaces_arrival_time', 'cold_start_without_serialized_state',
  'less_than_five_minutes_preroll', 'missing_sleeper_mode', 'missing_occupancy_context', 'missing_pump_context'])
export const replayContextQualificationSchema = z.object({ allowedLimitations: z.array(limitation).max(6).refine(codes => new Set(codes).size === codes.length, 'Duplicate qualified limitation') }).strict()
export type ReplayContextQualification = z.infer<typeof replayContextQualificationSchema>

/** Build-pinned driver diagnostics from every frozen cohort/configuration. A
 * threshold policy cannot implicitly approve replay approximations. */
export function verifyReplayContext(raw: unknown, expected: {
  cohortIds: string[]
  configHashes: string[]
  side: 'left' | 'right'
  pythonBuildHash: string
  otherSideConfigHash: string
}, qualification: ReplayContextQualification | null) {
  const reject = (message: string): never => {
    throw new ReferenceInputError('EVALUATION_NOT_VALIDATED', message)
  }
  if (!qualification) return reject('Waveform context has not been qualified')
  const allowed = replayContextQualificationSchema.parse(qualification).allowedLimitations
  const envelope = z.object({ hash: z.unknown(), outputs: z.unknown() }).parse(raw)
  const evaluation = waveformEvaluationSchema.parse(envelope)
  if (dataHash(evaluation.outputs) !== evaluation.hash) reject('Waveform diagnostic content hash changed')
  const required = new Set(expected.cohortIds.flatMap(cohort => [...new Set(expected.configHashes)].map(hash => `${cohort}:${hash}`)))
  const observed = new Set<string>()
  const otherSide = expected.side === 'left' ? 'right' : 'left'
  for (const output of evaluation.outputs) {
    if (!required.delete(`${output.cohortId}:${output.configHash}`)) reject('Unexpected or duplicated waveform context output')
    if (output.run.build_hash !== expected.pythonBuildHash || output.run.config_hashes[expected.side] !== output.configHash
      || output.run.config_hashes[otherSide] !== expected.otherSideConfigHash
      || output.run.counts.scored_outputs !== output.readings.length) reject('Waveform context identity changed')
    for (const reading of output.readings) {
      if (reading.configHash !== output.run.config_hashes[reading.side]) reject('Waveform reading identity changed')
    }
    const codes = [...output.run.limitations, ...output.readings.flatMap(reading => reading.limitations)]
    for (const code of codes) {
      if (!allowed.some(item => item === code)) reject(`Unqualified replay limitation: ${code}`)
      observed.add(code)
    }
  }
  if (required.size) reject('Missing waveform context output')
  return { version: 'qualified-replay-context-v1' as const, observedLimitations: [...observed].sort(),
    allowedLimitations: [...allowed].sort(), outputs: evaluation.outputs.length }
}
