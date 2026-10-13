'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { ShadowReport } from './ShadowReport'
import { ShadowSchedule } from './ShadowSchedule'

function useRunLabels() {
  const { t } = useLingui()
  return { pending: t`Scheduled`, running: t`Observing`, completed: t`Execution completed`, stopped: t`Stop recorded`, failed: t`Failed` }
}

export function ShadowRuns({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const labels = useRunLabels()
  const [cursor, setCursor] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const runs = trpc.biometricShadow.list.useQuery({ side, maximumRuns: 20, afterId: cursor }, { refetchInterval: 5000 })
  function changePage(next?: string) {
    setCursor(next)
    setSelected(undefined)
  }
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Prospective observations</Trans>} subtitle={<Trans>Compare a candidate alongside active processing. Observations do not change your active profile.</Trans>} />
      <ShadowSchedule side={side} />
      {runs.error
        ? <InlineError>{runs.error.message}</InlineError>
        : !runs.data
            ? <Skeleton className="h-24" />
            : (
                <>
                  {runs.data.items.length === 0 ? <p><Trans>No prospective runs for this side.</Trans></p> : null}
                  <ul className="space-y-3">
                    {runs.data.items.map(run => (
                      <li key={run.id} className="space-y-2 border-b border-border pb-3">
                        <p>{labels[run.state]}</p>
                        <p>{run.subjectId}</p>
                        <p className="break-all font-mono text-xs">{run.id}</p>
                        <Button aria-expanded={selected === run.id} onClick={() => setSelected(selected === run.id ? undefined : run.id)}><Trans>Inspect observation</Trans></Button>
                        {selected === run.id ? <ShadowRunDetails key={run.id} id={run.id} /> : null}
                      </li>
                    ))}
                  </ul>
                  {cursor ? <Button onClick={() => changePage()}><Trans>First page</Trans></Button> : null}
                  {runs.data.nextCursor ? <Button onClick={() => changePage(runs.data?.nextCursor ?? undefined)}><Trans>Next page</Trans></Button> : null}
                </>
              )}
      <p className="text-sm text-fg-2">{t`Reports describe observed coverage and reference agreement; they do not authorize activation.`}</p>
    </Card>
  )
}

export function ShadowRunDetails({ id }: { id: string }) {
  const { t, i18n } = useLingui()
  const labels = useRunLabels()
  const [showReport, setShowReport] = useState(false)
  const run = trpc.biometricShadow.get.useQuery({ id }, { refetchInterval: query => query.state.data && !['pending', 'running'].includes(query.state.data.state) ? false : 5000 })
  const stop = trpc.biometricShadow.stop.useMutation()
  const utils = trpc.useUtils()
  async function requestStop() {
    const response = await stop.mutateAsync({ id })
    utils.biometricShadow.get.setData({ id }, response.run)
    await utils.biometricShadow.list.invalidate()
    await utils.biometricShadow.report.invalidate({ id })
  }
  if (run.error) return <InlineError>{run.error.message}</InlineError>
  if (!run.data) return <Skeleton className="h-24" />
  const data = run.data
  const date = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC', hour12: false })
  return (
    <section aria-label={t`Observation details`} className="space-y-3">
      <p role="status">{labels[data.state]}</p>
      <p><Trans>Observation window (UTC)</Trans></p>
      <p>
        <time dateTime={new Date(data.startMs).toISOString()}>{date.format(data.startMs)}</time>
        {' – '}
        <time dateTime={new Date(data.endMs).toISOString()}>{date.format(data.endMs)}</time>
      </p>
      <p>{t`Saved observations: ${data.pointCount}`}</p>
      {data.state === 'pending' ? <p><Trans>Scheduled runs wait for their window and fresh resource admission. No observations are implied yet.</Trans></p> : null}
      {data.state === 'stopped' ? <p><Trans>The stop request is recorded. Saved observations are preserved.</Trans></p> : null}
      {!data.candidateIdentitySaved ? <p><Trans>This older run has no saved candidate revision identity.</Trans></p> : null}
      {['pending', 'running'].includes(data.state) ? <Button disabled={stop.isPending} onClick={() => void requestStop().catch(() => {})}><Trans>Stop observation</Trans></Button> : null}
      {stop.error ? <InlineError>{stop.error.message}</InlineError> : null}
      <Button aria-expanded={showReport} onClick={() => setShowReport(!showReport)}><Trans>Review observation report</Trans></Button>
      {showReport ? <ShadowReport id={id} side={data.side} subjectId={data.subjectId} /> : null}
      <details>
        <summary><Trans>Saved evidence identity</Trans></summary>
        <dl className="break-all text-xs">
          <dt><Trans>Candidate hash</Trans></dt>
          <dd>{data.candidateConfigHash}</dd>
          <dt><Trans>Active profile hash</Trans></dt>
          <dd>{data.activeConfigHash}</dd>
          <dt><Trans>Plan hash</Trans></dt>
          <dd>{data.planHash}</dd>
        </dl>
      </details>
    </section>
  )
}
