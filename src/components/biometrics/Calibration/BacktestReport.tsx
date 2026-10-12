'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { reportViewSchema, numericReportViewSchema, stageReportViewSchema } from './report-view'
import { NumericReport } from './NumericReport'
import { StageReport } from './StageReport'
import { StageTrace } from './StageTrace'

export function BacktestReport({ id }: { id: string }) {
  const { t, i18n } = useLingui()
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [showTrace, setShowTrace] = useState(false)
  const result = trpc.biometricTuning.getBacktestResult.useQuery({ id }, { staleTime: 60000 })
  const release = trpc.biometricTuning.releaseBacktestResult.useMutation()
  const utils = trpc.useUtils()
  if (result.error) return <InlineError>{result.error.message}</InlineError>
  if (result.data === undefined) return <Skeleton className="h-32" />
  if (result.data === null) return <p><Trans>No committed report is available yet.</Trans></p>
  const descriptor = result.data
  if (!descriptor.available) return (
    <div>
      <p><Trans>This report was released. Its audit hash remains, but detailed results are unavailable.</Trans></p>
      <p className="break-all text-xs">{descriptor.contentHash}</p>
    </div>
  )
  const parsed = reportViewSchema.safeParse(descriptor.report)
  if (!parsed.success) return <InlineError><Trans>This report version or structure is not supported by this view.</Trans></InlineError>
  const report = parsed.data
  const numeric = numericReportViewSchema.safeParse(descriptor.report)
  const stages = stageReportViewSchema.safeParse(descriptor.report)
  const labels: Record<string, string> = { default: t`System defaults`, current: t`Current stage view`, candidate: t`Candidate` }
  const splits = { tuning: t`Tuning`, validation: t`Validation`, holdout: t`Holdout` }
  const uncertaintyLabels = { not_requested: t`Not requested`, insufficient_nights: t`Insufficient paired nights`, degenerate: t`No estimable variation`, estimated: t`Exploratory interval estimated` }
  const percent = (value: number | null) => value === null ? t`Not scored` : new Intl.NumberFormat(i18n.locale || 'en', { style: 'percent', maximumFractionDigits: 2 }).format(value)
  async function releaseReport() {
    await release.mutateAsync({ id, expectedContentHash: descriptor.contentHash })
    setConfirmRelease(false)
    await utils.biometricTuning.getBacktestResult.invalidate({ id })
  }
  return (
    <section className="space-y-3" aria-label={t`Evaluation report`}>
      <p role="status" className="font-medium"><Trans>Insufficient evidence for validated improvement</Trans></p>
      <p>{splits[report.split]}</p>
      <p>{t`Current holdout exposure count: ${descriptor.currentHoldoutUseCount}`}</p>
      {report.evidence === 'reused_holdout_is_validation' || descriptor.currentHoldoutUseCount > 1 ? <p><Trans>Repeated holdout exposure weakens independent evidence. Treat reused holdout results as validation, not untouched holdout evidence.</Trans></p> : null}
      {report.protocol.mode === 'stage_replay' ? <p>{t`Assumed stage calibration quality: ${report.calibration.quality}`}</p> : <p><Trans>Original stored readings were compared; numerical parameter changes were not replayed.</Trans></p>}
      {report.limitations.map(limitation => <p key={limitation} className="text-sm text-fg-2">{limitation}</p>)}
      {report.stageNightSummary.map(summary => (
        <div key={`${summary.baselineHash}:${summary.candidateHash}:${summary.baseline}:${summary.candidate}`} className="space-y-2 border-t border-border pt-3">
          <p className="font-medium">
            {labels[summary.candidate] ?? summary.candidate}
            {' / '}
            {labels[summary.baseline] ?? summary.baseline}
          </p>
          <p>{t`Scored nights: ${summary.scoredNights}; unscored: ${summary.unscoredNights}; coverage reduced: ${summary.coverageReducedNights}`}</p>
          <p>{t`Higher agreement: ${summary.improvedAgreementNights}; lower: ${summary.regressedAgreementNights}; unchanged: ${summary.unchangedAgreementNights}`}</p>
          <p>{t`Equal-night mean agreement difference: ${percent(summary.equalNightMeanAgreementDifference)}`}</p>
          <table className="w-full text-left text-sm">
            <caption className="text-left"><Trans>Pooled common-support stage scores</Trans></caption>
            <thead>
              <tr>
                <th scope="col"><Trans>Configuration</Trans></th>
                <th scope="col"><Trans>Agreement</Trans></th>
                <th scope="col"><Trans>Macro F1</Trans></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{labels[summary.baseline] ?? summary.baseline}</th>
                <td>{percent(summary.pooledCommonSupport.baseline.agreement)}</td>
                <td>{percent(summary.pooledCommonSupport.baseline.macroF1)}</td>
              </tr>
              <tr>
                <th scope="row">{labels[summary.candidate] ?? summary.candidate}</th>
                <td>{percent(summary.pooledCommonSupport.candidate.agreement)}</td>
                <td>{percent(summary.pooledCommonSupport.candidate.macroF1)}</td>
              </tr>
            </tbody>
          </table>
          <p><Trans>Equal-night differences and pooled duration scores use different weighting. Coverage loss must be considered alongside score changes.</Trans></p>
          <p>{uncertaintyLabels[summary.uncertainty.status]}</p>
          {summary.uncertainty.interval ? <p>{t`Exploratory 95% interval: ${percent(summary.uncertainty.interval.lower)} to ${percent(summary.uncertainty.interval.upper)}`}</p> : null}
          {summary.uncertainty.limitations.map(limitation => <p key={limitation} className="text-xs text-fg-2">{limitation}</p>)}
        </div>
      ))}
      {report.protocol.mode === 'stage_replay' ? (stages.success ? <StageReport key={`stages:${descriptor.contentHash}`} report={stages.data} /> : <InlineError><Trans>Stage details are unavailable or incompatible.</Trans></InlineError>) : null}
      {numeric.success ? <NumericReport key={`numeric:${descriptor.contentHash}`} report={numeric.data} /> : <InlineError><Trans>Numerical details are unavailable or incompatible.</Trans></InlineError>}
      {report.protocol.mode === 'stage_replay' && numeric.success
        ? (
            <div>
              <Button onClick={() => setShowTrace(!showTrace)} aria-expanded={showTrace}><Trans>Inspect stage traces</Trans></Button>
              {showTrace ? <StageTrace key={descriptor.contentHash} id={id} hash={descriptor.contentHash} nights={numeric.data.nights} /> : null}
            </div>
          )
        : null}
      <details>
        <summary><Trans>Report identity</Trans></summary>
        <dl className="break-all text-xs">
          <dt><Trans>Report hash</Trans></dt>
          <dd>{descriptor.contentHash}</dd>
          <dt><Trans>Dataset hash</Trans></dt>
          <dd>{report.datasetHash}</dd>
          <dt><Trans>Protocol hash</Trans></dt>
          <dd>{report.protocolHash}</dd>
          <dt><Trans>Evaluator build hash</Trans></dt>
          <dd>{report.evaluatorBuildHash}</dd>
        </dl>
      </details>
      {confirmRelease
        ? (
            <div className="space-y-2">
              <p><Trans>Release detailed results permanently? The report hash, job history, and holdout exposure audit remain.</Trans></p>
              <Button disabled={release.isPending} onClick={() => void releaseReport().catch(() => {})}><Trans>Permanently release report</Trans></Button>
              <Button disabled={release.isPending} onClick={() => setConfirmRelease(false)}><Trans>Keep report</Trans></Button>
            </div>
          )
        : <Button onClick={() => setConfirmRelease(true)}><Trans>Release detailed report</Trans></Button>}
      {release.error ? <InlineError>{release.error.message}</InlineError> : null}
    </section>
  )
}
