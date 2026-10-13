'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { BacktestReport } from './BacktestReport'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'

function useJobLabels() {
  const { t } = useLingui()
  return { queued: t`Queued`, running: t`Running`, cancel_requested: t`Cancellation requested`, cancelled: t`Cancelled`, succeeded: t`Execution completed`, failed: t`Failed`, interrupted: t`Interrupted` }
}
export function BacktestJobs({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const labels = useJobLabels()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [selected, setSelected] = useState<string>()
  const jobs = trpc.biometricTuning.listBacktests.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id }, { refetchInterval: 5000 })
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Backtest jobs</Trans>} subtitle={<Trans>Execution state is separate from the strength of biometric evidence.</Trans>} />
      {jobs.error
        ? <InlineError>{jobs.error.message}</InlineError>
        : !jobs.data
            ? <Skeleton className="h-32" />
            : (
                <>
                  {jobs.data.items.length === 0 ? <p><Trans>No backtest jobs for this side.</Trans></p> : null}
                  <ul className="space-y-3">
                    {jobs.data.items.map(job => (
                      <li key={job.id} className="space-y-2 border-b border-border pb-3">
                        <p>{labels[job.state]}</p>
                        <p className="break-all font-mono text-xs">{job.id}</p>
                        <p>{t`Attempt ${job.attempt}`}</p>
                        <Button aria-expanded={selected === job.id} onClick={() => setSelected(selected === job.id ? undefined : job.id)}><Trans>Inspect job</Trans></Button>
                        {selected === job.id ? <BacktestJobDetails key={job.id} id={job.id} side={side} /> : null}
                      </li>
                    ))}
                  </ul>
                  {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest jobs</Trans></Button> : null}
                  {jobs.data.nextCursor ? <Button onClick={() => setCursor(jobs.data?.nextCursor ?? undefined)}><Trans>Older jobs</Trans></Button> : null}
                </>
              )}
    </Card>
  )
}
export function BacktestJobDetails({ id, side }: { id: string, side?: 'left' | 'right' }) {
  const { t } = useLingui()
  const labels = useJobLabels()
  const [showReport, setShowReport] = useState(false)
  const job = trpc.biometricTuning.getBacktest.useQuery({ id }, { refetchInterval: query => query.state.data && ['succeeded', 'failed', 'cancelled'].includes(query.state.data.state) ? false : 5000 })
  const cancel = trpc.biometricTuning.cancelBacktest.useMutation()
  const utils = trpc.useUtils()
  async function requestCancellation() {
    const updated = await cancel.mutateAsync({ id })
    utils.biometricTuning.getBacktest.setData({ id }, updated)
    await utils.biometricTuning.listBacktests.invalidate()
  }
  if (job.error) return <InlineError>{job.error.message}</InlineError>
  if (!job.data) return <Skeleton className="h-24" />
  const data = job.data
  const candidate = data.configurations.find(config => config.label === 'candidate')
  const splits = { tuning: t`Tuning`, validation: t`Validation`, holdout: t`Holdout` }
  const configurations: Record<string, string> = { default: t`System defaults`, current: t`Current stage view`, candidate: t`Candidate` }
  return (
    <section aria-label={t`Job details`} className="space-y-3">
      <p role="status">{labels[data.state]}</p>
      <p>
        {splits[data.split]}
        {' — '}
        {data.evaluationScope === 'retained_waveform_replay' ? <Trans>Retained waveform replay</Trans> : data.evaluationScope === 'stage_rules_on_original_readings' ? <Trans>Stage rules on original readings</Trans> : <Trans>Original stored-reading comparison</Trans>}
      </p>
      <p>{t`Progress: ${data.progress.completedNights} / ${data.progress.totalNights} nights`}</p>
      {data.progress.totalNights > 0 ? <progress aria-label={t`Completed nights`} value={data.progress.completedNights} max={data.progress.totalNights} /> : <p><Trans>Night progress is not available yet.</Trans></p>}
      <p>{data.progress.phase}</p>
      {data.error ? <InlineError>{data.error}</InlineError> : null}
      {data.state === 'queued' ? <p><Trans>Waiting for a worker and resource admission. No execution is implied by a queued request.</Trans></p> : null}
      {data.state === 'succeeded' ? <p><Trans>Execution completed. Review the report before drawing conclusions about agreement or improvement.</Trans></p> : null}
      {['queued', 'running', 'interrupted'].includes(data.state) ? <Button disabled={cancel.isPending} onClick={() => void requestCancellation().catch(() => {})}><Trans>Cancel backtest</Trans></Button> : null}
      {cancel.error ? <InlineError>{cancel.error.message}</InlineError> : null}
      {data.state === 'succeeded' ? <Button aria-expanded={showReport} onClick={() => setShowReport(!showReport)}><Trans>Review report</Trans></Button> : null}
      {showReport && data.state === 'succeeded' ? <BacktestReport id={id} candidate={side && data.split === 'holdout' && candidate?.revisionId ? { side, revisionId: candidate.revisionId, hash: candidate.hash } : undefined} /> : null}
      <details>
        <summary><Trans>Pinned job inputs</Trans></summary>
        <dl className="break-all text-xs">
          <dt><Trans>Dataset</Trans></dt>
          <dd>{data.datasetId}</dd>
          <dt><Trans>Dataset hash</Trans></dt>
          <dd>{data.datasetHash}</dd>
          <dt><Trans>Evaluator build hash</Trans></dt>
          <dd>{data.evaluatorBuildHash}</dd>
        </dl>
        <ul>
          {data.configurations.map(config => (
            <li key={config.label} className="break-all text-xs">
              {configurations[config.label] ?? config.label}
              {': '}
              {config.hash}
              {' — '}
              {config.revisionId ?? '—'}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
