'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/src/components/ds'
import type { StageReportView, StageScoreView } from './report-view'

const stages = ['wake', 'light', 'deep', 'rem'] as const

function StageScores({ score }: { score: StageScoreView }) {
  const { t, i18n } = useLingui()
  const labels = { wake: t`Wake`, light: t`Light`, deep: t`Deep`, rem: t`REM` }
  const minutes = (value: number) => new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 2 }).format(value / 60000)
  const percent = (value: number | null) => value === null ? t`Not scored` : new Intl.NumberFormat(i18n.locale || 'en', { style: 'percent', maximumFractionDigits: 2 }).format(value)
  return (
    <div className="space-y-2 overflow-x-auto">
      <p>{t`Common paired minutes: ${minutes(score.pairedDurationMs)}`}</p>
      <p>
        <Trans>Agreement</Trans>
        {': '}
        {percent(score.agreement)}
        {'; '}
        <Trans>Macro F1</Trans>
        {': '}
        {percent(score.macroF1)}
      </p>
      <table className="w-full text-left text-sm">
        <caption className="text-left"><Trans>Confusion matrix in minutes: reference rows, predicted columns</Trans></caption>
        <thead>
          <tr>
            <th scope="col"><Trans>Reference / predicted</Trans></th>
            {stages.map(stage => <th key={stage} scope="col">{labels[stage]}</th>)}
          </tr>
        </thead>
        <tbody>
          {stages.map(reference => (
            <tr key={reference}>
              <th scope="row">{labels[reference]}</th>
              {stages.map(predicted => <td key={predicted}>{minutes(score.confusionMs[reference][predicted])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-left text-sm">
        <caption className="text-left"><Trans>Per-stage scores on common paired intervals</Trans></caption>
        <thead>
          <tr>
            <th scope="col"><Trans>Stage</Trans></th>
            <th scope="col"><Trans>Reference minutes</Trans></th>
            <th scope="col"><Trans>Predicted minutes</Trans></th>
            <th scope="col"><Trans>Precision</Trans></th>
            <th scope="col"><Trans>Recall</Trans></th>
            <th scope="col"><Trans>F1</Trans></th>
          </tr>
        </thead>
        <tbody>
          {score.perStage.map(row => (
            <tr key={row.stage}>
              <th scope="row">{labels[row.stage]}</th>
              <td>{minutes(row.referenceMs)}</td>
              <td>{minutes(row.predictedMs)}</td>
              <td>{percent(row.precision)}</td>
              <td>{percent(row.recall)}</td>
              <td>{percent(row.f1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StageComparison({ comparison }: { comparison: StageReportView['stageNightSummary'][number] }) {
  const { t, i18n } = useLingui()
  const [page, setPage] = useState(0)
  const labels: Record<string, string> = { default: t`System defaults`, current: t`Current stage view`, candidate: t`Candidate` }
  const percent = (value: number | null) => value === null ? t`Not scored` : new Intl.NumberFormat(i18n.locale || 'en', { style: 'percent', maximumFractionDigits: 2 }).format(value)
  const minutes = (value: number) => new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 2 }).format(value / 60000)
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <h5 className="font-medium">
        {labels[comparison.candidate] ?? comparison.candidate}
        {' / '}
        {labels[comparison.baseline] ?? comparison.baseline}
      </h5>
      <details>
        <summary><Trans>Pooled stage confusion</Trans></summary>
        {(['baseline', 'candidate'] as const).map(role => (
          <div key={role}>
            <h6>{labels[comparison[role]] ?? comparison[role]}</h6>
            <StageScores score={comparison.pooledCommonSupport[role]} />
          </div>
        ))}
      </details>
      {comparison.nights.slice(page * 10, page * 10 + 10).map(night => (
        <details key={night.cohortId}>
          <summary>{t`Night ${night.cohortId}`}</summary>
          <p>{t`Evaluated minutes: ${minutes(night.evaluationDurationMs)}`}</p>
          <p>{night.coverageReduced ? t`Coverage reduced in at least one evaluated window` : t`No coverage reduction detected`}</p>
          <p>{t`Common-support agreement difference: ${percent(night.commonAgreementDifference)}`}</p>
          <p>{t`Common-support macro F1 difference: ${percent(night.commonMacroF1Difference)}`}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="text-left"><Trans>Each configuration on its own available intervals</Trans></caption>
              <thead>
                <tr>
                  <th scope="col"><Trans>Configuration</Trans></th>
                  <th scope="col"><Trans>Agreement</Trans></th>
                  <th scope="col"><Trans>Output coverage</Trans></th>
                  <th scope="col"><Trans>Reference coverage</Trans></th>
                  <th scope="col"><Trans>Output minutes</Trans></th>
                  <th scope="col"><Trans>Paired minutes</Trans></th>
                  <th scope="col"><Trans>Eligible reference minutes</Trans></th>
                </tr>
              </thead>
              <tbody>
                {(['baseline', 'candidate'] as const).map((role) => {
                  const own = night.ownSupport[role]
                  return (
                    <tr key={role}>
                      <th scope="row">{labels[comparison[role]] ?? comparison[role]}</th>
                      <td>{percent(own.agreement)}</td>
                      <td>{percent(own.outputCoverage)}</td>
                      <td>{percent(own.referenceCoverage)}</td>
                      <td>{minutes(own.outputMs)}</td>
                      <td>{minutes(own.pairedMs)}</td>
                      <td>{minutes(own.referenceMs)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(['baseline', 'candidate'] as const).map(role => (
            <details key={role}>
              <summary>{t`Common-support details: ${labels[comparison[role]] ?? comparison[role]}`}</summary>
              <StageScores score={night.commonSupport[role]} />
            </details>
          ))}
        </details>
      ))}
      <div className="flex gap-2">
        <Button disabled={page === 0} onClick={() => setPage(page - 1)}><Trans>Previous report nights</Trans></Button>
        <Button disabled={(page + 1) * 10 >= comparison.nights.length} onClick={() => setPage(page + 1)}><Trans>Next report nights</Trans></Button>
      </div>
    </div>
  )
}

export function StageReport({ report }: { report: StageReportView }) {
  return (
    <section className="space-y-3">
      <h4 className="font-medium"><Trans>Stage coverage and confusion by night</Trans></h4>
      <p><Trans>Common support is the intersection of all evaluated configurations and eligible reference intervals. Own-support scores use each configuration’s available intervals and may describe different portions of the night.</Trans></p>
      <p><Trans>Output coverage uses evaluated time as its denominator. Reference coverage uses eligible reference time. A higher score with reduced coverage is not sufficient evidence of improvement.</Trans></p>
      {report.stageNightSummary.map(comparison => <StageComparison key={`${comparison.baseline}:${comparison.candidate}:${comparison.baselineHash}:${comparison.candidateHash}`} comparison={comparison} />)}
    </section>
  )
}
