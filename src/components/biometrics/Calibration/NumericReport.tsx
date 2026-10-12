'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import type { NumericReportView } from './report-view'

export function NumericReport({ report }: { report: NumericReportView }) {
  const { t, i18n } = useLingui()
  const [page, setPage] = useState(0)
  const timeFormat = useTimeFormat()
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  let timezone = settings.data?.device.timezone ?? 'UTC'
  let dates: Intl.DateTimeFormat
  try {
    dates = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  catch {
    timezone = 'UTC'
    dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  const number = (value: number | null | undefined) => value == null ? t`Not scored` : new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 3 }).format(value)
  const percent = (value: number | null) => value === null ? t`Not scored` : new Intl.NumberFormat(i18n.locale || 'en', { style: 'percent', maximumFractionDigits: 2 }).format(value)
  const labels = { default: t`System defaults`, current: t`Current stage view`, candidate: t`Candidate` }
  const metrics = { heart_rate: t`Heart rate (bpm)`, breathing_rate: t`Breathing rate (breaths/min)`, window_ibi_variability_v1: t`Window IBI variability index (ms)` }
  const statuses = { compared: t`Compared`, no_reference: t`No reference`, no_overlap: t`No overlap`, incompatible: t`Incompatible reference` }
  const start = page * 10
  return (
    <section className="space-y-3" aria-label={t`Numerical errors by night`}>
      <h4 className="font-medium"><Trans>Numerical errors by night</Trans></h4>
      <p><Trans>These scores compare original stored readings. Identical numerical results across profiles do not validate numerical parameter changes.</Trans></p>
      <p><Trans>Reference coverage is the fraction of eligible reference records paired. Output coverage is the fraction of stored observations with a value, not continuous time coverage. Sparse samples cannot establish whole-night accuracy.</Trans></p>
      <p><Trans>The window IBI variability index is not clinical beat-to-beat RMSSD. Only compatible metric definitions and aggregation windows are scored.</Trans></p>
      <p>{t`Times shown in ${timezone}`}</p>
      {report.nights.length === 0 ? <p><Trans>No nights in this report.</Trans></p> : null}
      {report.nights.slice(start, start + 10).map(night => (
        <details key={night.cohortId}>
          <summary>{t`Night ${night.cohortId}`}</summary>
          {night.evaluations.map(evaluation => (
            <div key={evaluation.label} className="space-y-2 py-2">
              <h5 className="font-medium">{labels[evaluation.label]}</h5>
              <p className="break-all text-xs">{evaluation.configHash}</p>
              {evaluation.windows.map(window => (
                <div key={`${window.startMs}:${window.endMs}`} className="space-y-2 overflow-x-auto">
                  <p>
                    {dates.format(window.startMs)}
                    {' – '}
                    {dates.format(window.endMs)}
                  </p>
                  <p>{t`Stored observations: ${window.observationCount}`}</p>
                  <table className="w-full text-left text-sm">
                    <caption className="text-left"><Trans>Errors use the metric unit; signed bias is pod minus reference.</Trans></caption>
                    <thead>
                      <tr>
                        <th scope="col"><Trans>Metric</Trans></th>
                        <th scope="col"><Trans>Status</Trans></th>
                        <th scope="col"><Trans>MAE</Trans></th>
                        <th scope="col"><Trans>Median absolute error</Trans></th>
                        <th scope="col"><Trans>95th percentile absolute error</Trans></th>
                        <th scope="col"><Trans>Signed bias</Trans></th>
                        <th scope="col"><Trans>Paired records</Trans></th>
                        <th scope="col"><Trans>Reference coverage</Trans></th>
                        <th scope="col"><Trans>Output coverage</Trans></th>
                        <th scope="col"><Trans>Unmatched references</Trans></th>
                        <th scope="col"><Trans>Unmatched observations</Trans></th>
                      </tr>
                    </thead>
                    <tbody>
                      {window.numeric.map(row => (
                        <tr key={row.metric}>
                          <th scope="row">{metrics[row.metric]}</th>
                          <td>{statuses[row.status]}</td>
                          <td>{number(row.metrics?.mae)}</td>
                          <td>{number(row.metrics?.medianAbsoluteError)}</td>
                          <td>{number(row.metrics?.p95AbsoluteError)}</td>
                          <td>{number(row.metrics?.signedBias)}</td>
                          <td>{number(row.pairedCount)}</td>
                          <td>{percent(row.referenceCoverage)}</td>
                          <td>{percent(row.outputCoverage)}</td>
                          <td>{number(row.unmatchedReferences)}</td>
                          <td>{number(row.unmatchedObservations)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {window.numeric.filter(row => Object.keys(row.exclusions).length > 0).map(row => (
                    <details key={row.metric}>
                      <summary>{t`Exclusions: ${metrics[row.metric]}`}</summary>
                      <dl>
                        {Object.entries(row.exclusions).map(([reason, count]) => (
                          <div key={reason}>
                            <dt>{reason}</dt>
                            <dd>{number(count)}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </details>
      ))}
      <div className="flex gap-2">
        <Button disabled={page === 0} onClick={() => setPage(page - 1)}><Trans>Previous report nights</Trans></Button>
        <Button disabled={start + 10 >= report.nights.length} onClick={() => setPage(page + 1)}><Trans>Next report nights</Trans></Button>
      </div>
    </section>
  )
}
