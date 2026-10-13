'use client'

import { Trans, useLingui } from '@lingui/react/macro'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { ShadowComparison } from './ShadowComparison'

export function ShadowReport({ id, side, subjectId }: { id: string, side?: 'left' | 'right', subjectId?: string }) {
  const { t, i18n } = useLingui()
  const report = trpc.biometricShadow.report.useQuery({ id }, { staleTime: Infinity, refetchOnWindowFocus: false, retry: false })
  const percent = new Intl.NumberFormat(i18n.locale || 'en', { style: 'percent', maximumFractionDigits: 1 })
  const number = new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 2 })
  const coverage = (value: number | null) => value === null ? t`Unavailable` : percent.format(value)
  const issues: Record<string, string> = {
    clock_skew: t`Observation clocks are inconsistent.`, join_failed: t`Candidate and active readings could not be paired reliably.`,
    observation_window_missed: t`The observation window was missed.`, processor_failed: t`Processing failed.`,
    simulated_demo: t`Simulated demo: generated readings, no hardware execution or qualification.`,
    worker_cleanup_unconfirmed: t`Worker cleanup has not been confirmed.`, storage_quota: t`The storage quota was reached.`,
    worker_stale: t`Worker health observations are stale.`, observation_gap: t`The observation gap exceeded the planned limit.`,
    no_observations: t`No observations were saved.`, coverage_degraded: t`Candidate coverage fell below the planned limits.`,
  }
  if (report.error) return (
    <div className="space-y-2">
      <InlineError>{report.error.message}</InlineError>
      <Button disabled={report.isFetching} onClick={() => void report.refetch()}><Trans>Retry report</Trans></Button>
    </div>
  )
  if (!report.data) return <Skeleton className="h-32" />
  const data = report.data
  const metrics = { heart_rate: t`Heart rate`, breathing_rate: t`Breathing rate`, window_ibi_variability_v1: t`Window IBI variability index` }
  return (
    <section aria-label={t`Prospective observation report`} className="space-y-3">
      <h4><Trans>Observation report</Trans></h4>
      <p>{data.health === 'waiting' ? t`Waiting for the observation window.` : data.health === 'issues_detected' ? t`Observed issues need review.` : t`Within the observed limits.`}</p>
      <p><Trans>This is descriptive evidence, not validated improvement or permission to activate a profile.</Trans></p>
      <p>{t`Saved sample times: ${data.observedSamples}. Planned observation intervals: ${data.expectedSlots}.`}</p>
      <p>{t`Largest observation gap: ${number.format(data.maximumGapMs / 1000)} seconds.`}</p>
      {data.issues.length ? <ul className="list-disc pl-5">{data.issues.map(issue => <li key={issue}>{issues[issue] ?? t`An additional report issue needs review.`}</li>)}</ul> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="text-left"><Trans>Coverage of planned observation intervals</Trans></caption>
          <thead>
            <tr>
              <th scope="col"><Trans>Metric</Trans></th>
              <th scope="col"><Trans>Active</Trans></th>
              <th scope="col"><Trans>Candidate</Trans></th>
            </tr>
          </thead>
          <tbody>
            {data.metrics.map(metric => (
              <tr key={metric.metric}>
                <th scope="row">{metrics[metric.metric]}</th>
                <td>{coverage(metric.current.coverage)}</td>
                <td>{coverage(metric.candidate.coverage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p><Trans>Missing observations remain missing. The IBI variability index is not clinical RMSSD.</Trans></p>
      {data.workerReceipt?.schema === 'biometric-shadow-partial-receipt-v1' ? <p><Trans>Resource observations are partial. Worker health reflects the last valid reply, not the complete attempt.</Trans></p> : null}
      {data.workerReceipt && data.workerReceipt.receipt.peakObservedRssBytes !== null
        ? <p>{t`Sampled worker memory peak: ${number.format(data.workerReceipt.receipt.peakObservedRssBytes / (1024 * 1024))} MiB. Short peaks between samples may be missed.`}</p>
        : data.workerReceipt ? <p><Trans>No worker memory observation is available.</Trans></p> : <p><Trans>No completed worker resource receipt is available.</Trans></p>}
      <p><Trans>Presence and pump context reflect host observations, not proof of the live processor’s cached state.</Trans></p>
      <Button disabled={report.isFetching} onClick={() => void report.refetch()}><Trans>Refresh report</Trans></Button>
      {side && subjectId !== undefined ? <ShadowComparison key={id} id={id} side={side} subjectId={subjectId} /> : null}
      <details>
        <summary><Trans>Report evidence</Trans></summary>
        <dl className="break-all text-xs">
          <dt><Trans>Report hash</Trans></dt>
          <dd>{data.reportHash}</dd>
          <dt><Trans>Snapshot hash</Trans></dt>
          <dd>{data.snapshotHash}</dd>
        </dl>
      </details>
    </section>
  )
}
