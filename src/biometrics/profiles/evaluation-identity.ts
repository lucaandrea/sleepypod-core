import { z } from 'zod'
import { configHash, dataHash } from '../algorithms/canonical'
import { defaultConfig, manifestHash, validateConfig } from '../algorithms/registry'
import { backtestJobSnapshotSchema, experimentProtocolSchema } from '../backtest/contracts'
import { ReferenceInputError } from '../references/time'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const reportIdentitySchema = z.object({
  version: z.enum(['waveform-backtest-report-v1', 'processed-backtest-report-v1']),
  side: z.enum(['left', 'right']), datasetId: z.string().uuid(), datasetHash: hash,
  protocol: experimentProtocolSchema, protocolHash: hash, evaluatorBuildHash: hash, manifestHash: hash,
  split: z.literal('holdout'), holdoutUse: z.literal(1),
  support: z.enum(['identical_retained_waveform_inputs', 'identical_retained_epoch_intervals']),
  nights: z.array(z.object({ cohortId: z.string() })).min(1).max(60),
  waveform: z.object({ pythonBuildHash: hash, otherSideConfigHash: hash }).optional(),
})

/** These expectations are loaded by the service from the profile binding,
 * immutable dataset and installed build. They must never come from a client. */
export interface EvaluationIdentityExpectation {
  side: 'left' | 'right'
  revisionId: string
  resolvedHash: string
  currentResolvedHash: string
  evaluatorBuildHash: string
  dataset: { id: string, contentHash: string, side: 'left' | 'right', available: boolean, holdoutCohortIds: string[] }
  waveform?: { pythonBuildHash: string, otherSideConfigHash: string }
}

/** Necessary identity checks only: this does not designate a policy, award
 * improvement, or authorize activation. Assessments must be verified next. */
export function verifyEvaluationIdentity(rawJob: unknown, result: {
  report: unknown
  contentHash: string
  available: boolean
  currentHoldoutUseCount: number
}, expected: EvaluationIdentityExpectation) {
  const reject = (message: string): never => {
    throw new ReferenceInputError('EVALUATION_MISMATCH', message)
  }
  if (!result.available || !expected.dataset.available) reject('Retained evaluation artifacts are unavailable')
  if (dataHash(result.report) !== result.contentHash) reject('Evaluation content hash does not match')
  const job = backtestJobSnapshotSchema.parse(rawJob)
  const report = reportIdentitySchema.parse(result.report)
  if (job.split !== 'holdout' || job.holdoutUse !== 1 || result.currentHoldoutUseCount !== 1 || job.evidence === 'reused_holdout_is_validation') reject('Independent holdout has been reused or was not evaluated')
  if (report.side !== expected.side || expected.dataset.side !== expected.side
    || job.datasetId !== expected.dataset.id || report.datasetId !== job.datasetId
    || job.datasetHash !== expected.dataset.contentHash || report.datasetHash !== job.datasetHash) reject('Evaluation dataset or side changed')
  if (job.evaluatorBuildHash !== expected.evaluatorBuildHash || report.evaluatorBuildHash !== job.evaluatorBuildHash
    || report.manifestHash !== manifestHash) reject('Evaluation build is incompatible')
  if (configHash(job.protocol) !== job.protocolHash || report.protocolHash !== job.protocolHash
    || configHash(report.protocol) !== job.protocolHash) reject('Evaluation protocol identity changed')
  if (job.configs.length !== 3 || new Set(job.configs.map(row => row.label)).size !== 3) reject('Evaluation must include default, current and candidate')
  for (const config of job.configs) {
    if (config.manifestHash !== manifestHash || configHash(validateConfig(config.resolved)) !== config.resolvedHash) reject('Evaluated configuration identity changed')
    if (config.label === 'default' && (config.revisionId !== null || config.resolvedHash !== configHash(defaultConfig))) reject('Evaluated default does not match the shipped default')
    if (config.label === 'current' && config.resolvedHash !== expected.currentResolvedHash) reject('Current baseline changed since evaluation')
    if (config.label === 'candidate' && (config.revisionId !== expected.revisionId || config.resolvedHash !== expected.resolvedHash)) reject('Evaluation belongs to another candidate revision')
  }
  const cohorts = report.nights.map(row => row.cohortId)
  if (new Set(cohorts).size !== cohorts.length || new Set(expected.dataset.holdoutCohortIds).size !== expected.dataset.holdoutCohortIds.length
    || cohorts.length !== expected.dataset.holdoutCohortIds.length || cohorts.some(id => !expected.dataset.holdoutCohortIds.includes(id))) reject('Evaluation does not cover the exact frozen holdout nights')
  if (job.protocol.mode === 'signal_replay') {
    if (!expected.waveform || !job.waveform || !report.waveform
      || job.waveform.pythonBuildHash !== expected.waveform.pythonBuildHash || report.waveform.pythonBuildHash !== job.waveform.pythonBuildHash
      || job.waveform.otherSide.resolvedHash !== expected.waveform.otherSideConfigHash || report.waveform.otherSideConfigHash !== job.waveform.otherSide.resolvedHash
      || job.waveform.otherSide.manifestHash !== manifestHash || configHash(validateConfig(job.waveform.otherSide.resolved)) !== job.waveform.otherSide.resolvedHash
      || report.version !== 'waveform-backtest-report-v1' || report.support !== 'identical_retained_waveform_inputs') reject('Waveform dependencies changed since evaluation')
  }
  else if (job.protocol.mode !== 'stage_replay' || job.waveform || report.waveform
    || report.version !== 'processed-backtest-report-v1' || report.support !== 'identical_retained_epoch_intervals') reject('Evaluation mode cannot validate the selected replay')
  return { job, report, contentHash: result.contentHash, cohortIds: cohorts }
}
