'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import type { NumericReportView } from './report-view'

export function NumericReport({ report, waveform = false }: { report: NumericReportView, waveform?: boolean }) {
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
  const labels = { default: t`System defaults`, current: waveform ? t`Current baseline` : t`Current stage view`, candidate: t`Candidate` }
  const metrics = { heart_rate: t`Heart rate (bpm)`, breathing_rate: t`Breathing rate (breaths/min)`, window_ibi_variability_v1: t`Window IBI variability index (ms)` }
  const uncertaintyLabels = { not_requested: t`Not requested`, insufficient_nights: t`Insufficient paired nights`, degenerate: t`No estimable variation`, estimated: t`Exploratory interval estimated` }
  const statuses = { compared: t`Compared`, no_reference: t`No reference`, no_overlap: t`No overlap`, incompatible: t`Incompatible reference` }
  const groups = { reference_points: t`Reference points`, reference_intervals: t`Reference intervals`, window_first_half: t`First half of each window`, window_second_half: t`Second half of each window` }
  const start = page * 10
  return (
    <section className="space-y-3" aria-label={t`Numerical errors by night`}>
      <h4 className="font-medium"><Trans>Numerical errors by night</Trans></h4>
      {waveform
        ? <p><Trans>These scores compare readings recomputed from retained waveforms. Shared-timestamp scores use observations available in every configuration. Differences describe agreement with the reference and do not establish validated improvement.</Trans></p>
        : <p><Trans>These scores compare original stored readings. Identical numerical results across profiles do not validate numerical parameter changes.</Trans></p>}
      <p><Trans>Reference coverage is the fraction of eligible reference records paired. Output coverage is the fraction of observations with a value, not continuous time coverage. Sparse samples cannot establish whole-night accuracy.</Trans></p>
      <p><Trans>The window IBI variability index is not clinical beat-to-beat RMSSD. Only compatible metric definitions and aggregation windows are scored.</Trans></p>
      {waveform && !!report.numericSubgroupSummary?.length
        ? (
            <details>
              <summary><Trans>Reference-defined subgroup comparisons</Trans></summary>
              <p><Trans>Groups use native reference timestamps and record types, independently of candidate output. Half-window groups exclude intervals crossing the midpoint. Groups overlap and are not independent experiments. These are not motion or artifact subgroups.</Trans></p>
              {report.numericSubgroupSummary.map(group => (
                <div key={`${group.name}:${group.summary.metric}:${group.summary.baseline}:${group.summary.candidate}`} className="space-y-1 border-t border-border py-2">
                  <h5>
                    {groups[group.name]}
                    {' — '}
                    {metrics[group.summary.metric]}
                    {' — '}
                    {labels[group.summary.candidate]}
                    {' / '}
                    {labels[group.summary.baseline]}
                  </h5>
                  <p>{t`Scored nights: ${group.summary.scoredNights}; unscored: ${group.summary.unscoredNights}`}</p>
                  <p>{t`Equal-night mean MAE difference: ${number(group.summary.equalNightMeanMaeDifference)}`}</p>
                  <p>{t`Reference intervals excluded at window midpoints: ${group.excludedBoundaryReferenceCount}`}</p>
                </div>
              ))}
            </details>
          )
        : null}
      {waveform
        ? report.numericNightSummary?.map(summary => (
            <div key={`${summary.metric}:${summary.baseline}:${summary.candidate}:${summary.baselineHash}:${summary.candidateHash}`} className="space-y-2 border-t border-border pt-3">
              <h5 className="font-medium">
                {metrics[summary.metric]}
                {' — '}
                {labels[summary.candidate]}
                {' / '}
                {labels[summary.baseline]}
              </h5>
              <p>{t`Scored nights: ${summary.scoredNights}; unscored: ${summary.unscoredNights}; coverage reduced: ${summary.coverageReducedNights}`}</p>
              <p>{t`Lower error: ${summary.improvedErrorNights}; higher: ${summary.regressedErrorNights}; unchanged: ${summary.unchangedErrorNights}`}</p>
              <p>{t`Equal-night mean MAE difference: ${number(summary.equalNightMeanMaeDifference)}`}</p>
              <p>{t`Pooled shared MAE — baseline: ${number(summary.pooledCommonSupport.baseline.mae)}; comparison: ${number(summary.pooledCommonSupport.candidate.mae)}`}</p>
              <p><Trans>Errors use the metric unit. Reference pairs are weighted equally within each night; nights are weighted equally in the mean difference. Pooled scores weight all reference pairs equally.</Trans></p>
              <p>{uncertaintyLabels[summary.uncertainty.status]}</p>
              {summary.uncertainty.interval ? <p>{t`Exploratory 95% interval for MAE difference: ${number(summary.uncertainty.interval.lower)} to ${number(summary.uncertainty.interval.upper)}`}</p> : null}
              {summary.uncertainty.limitations.map(limitation => <p key={limitation} className="text-xs text-fg-2">{limitation}</p>)}
            </div>
          ))
        : null}
      <p>{t`Times shown in ${timezone}`}</p>
      {report.nights.length === 0 ? <p><Trans>No nights in this report.</Trans></p> : null}
      {report.nights.slice(start, start + 10).map(night => (
        <details key={night.cohortId}>
          <summary>{t`Night ${night.cohortId}`}</summary>
          {waveform && !night.numericComparisons ? <p><Trans>Shared-timestamp comparisons are unavailable in this report.</Trans></p> : null}
          {waveform
            ? night.numericComparisons?.map(window => (
                <div key={`comparison:${window.startMs}:${window.endMs}`} className="space-y-2 overflow-x-auto">
                  <p>
                    {dates.format(window.startMs)}
                    {' – '}
                    {dates.format(window.endMs)}
                  </p>
                  <table className="w-full text-left text-sm">
                    <caption className="text-left"><Trans>Shared-timestamp comparisons. Differences are comparison minus baseline; negative error differences mean lower error on shared observations.</Trans></caption>
                    <thead>
                      <tr>
                        <th scope="col"><Trans>Metric</Trans></th>
                        <th scope="col"><Trans>Comparison / baseline</Trans></th>
                        <th scope="col"><Trans>Shared observations</Trans></th>
                        <th scope="col"><Trans>Baseline shared MAE</Trans></th>
                        <th scope="col"><Trans>Comparison shared MAE</Trans></th>
                        <th scope="col"><Trans>Shared MAE difference</Trans></th>
                        <th scope="col"><Trans>Own-support MAE difference</Trans></th>
                        <th scope="col"><Trans>Lost readings</Trans></th>
                        <th scope="col"><Trans>Added readings</Trans></th>
                        <th scope="col"><Trans>Ambiguous timestamps (baseline / comparison)</Trans></th>
                      </tr>
                    </thead>
                    <tbody>
                      {window.metrics.map(row => (
                        <tr key={`${row.metric}:${row.baseline}:${row.candidate}`}>
                          <th scope="row">{metrics[row.metric]}</th>
                          <td>
                            {labels[row.candidate]}
                            {' / '}
                            {labels[row.baseline]}
                          </td>
                          <td>{number(row.commonObservationCount)}</td>
                          <td>{number(row.commonSupport.baseline.metrics?.mae)}</td>
                          <td>{number(row.commonSupport.candidate.metrics?.mae)}</td>
                          <td>{number(row.differences.commonMae)}</td>
                          <td>{number(row.differences.ownMae)}</td>
                          <td>
                            {number(row.lostObservationTimestamps)}
                            {row.coverageReduced
                              ? (
                                  <>
                                    {' '}
                                    —
                                    <Trans>Coverage reduced</Trans>
                                  </>
                                )
                              : null}
                          </td>
                          <td>{number(row.addedObservationTimestamps)}</td>
                          <td>
                            {number(row.ambiguousObservationTimestamps.baseline)}
                            {' / '}
                            {number(row.ambiguousObservationTimestamps.candidate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p><Trans>Dropping readings can lower own-support error. Duplicate timestamps are excluded from shared support. These counts do not measure continuous time coverage.</Trans></p>
                </div>
              ))
            : null}
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
                  <p>{waveform ? t`Recomputed observations: ${window.observationCount}` : t`Stored observations: ${window.observationCount}`}</p>
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
