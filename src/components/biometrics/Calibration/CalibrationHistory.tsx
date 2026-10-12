'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'

export function CalibrationHistory({ side }: { side: 'left' | 'right' }) {
  const { t, i18n } = useLingui()
  const timeFormat = useTimeFormat()
  const [beforeGeneration, setBeforeGeneration] = useState<number>()
  const history = trpc.biometricTuning.listActivationHistory.useQuery({ side, beforeGeneration }, { refetchInterval: beforeGeneration === undefined ? 5000 : false })
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  const timezone = settings.data?.device.timezone ?? 'UTC'
  const dates = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, hour12: timeFormat !== '24h' })
  const actions: Record<string, string> = { activate: t`Apply profile`, reset: t`Use system defaults`, rollback: t`Restore previous profile`, migration: t`Migrate settings`, fallback: t`Compatibility fallback` }
  const states: Record<string, string> = { saved: t`Saved`, pending_delivery: t`Waiting for delivery`, pending_boundary: t`Waiting for a processing boundary`, applied: t`Applied`, failed: t`Failed` }
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Activation history</Trans>} subtitle={<Trans>Past acknowledgements do not establish which profile is running now.</Trans>} />
      <p className="text-xs text-fg-2">
        {t`Times shown in ${timezone}`}
      </p>
      {history.error
        ? <InlineError>{history.error.message}</InlineError>
        : !history.data
            ? <Skeleton className="h-40" />
            : history.data.items.length === 0
              ? <p><Trans>No activation history for this side.</Trans></p>
              : (
                  <ol className="space-y-4">
                    {history.data.items.map(event => (
                      <li key={event.id} className="space-y-1 border-b border-border pb-3 text-sm">
                        <div className="flex flex-wrap justify-between gap-2">
                          <strong>{actions[event.action]}</strong>
                          <span>{states[event.state]}</span>
                        </div>
                        <time dateTime={new Date(event.createdAtMs).toISOString()}>{dates.format(event.createdAtMs)}</time>
                        <p className="text-fg-2">
                          {t`Generation ${event.generation}`}
                        </p>
                        {event.reason ? <p>{event.reason}</p> : null}
                        <details>
                          <summary className="cursor-pointer"><Trans>Exact profile transition</Trans></summary>
                          <p className="break-all font-mono text-xs">
                            {event.previousHash}
                            {' '}
                            →
                            {' '}
                            {event.nextHash}
                          </p>
                          <p>
                            {t`Requested by ${event.requester}`}
                          </p>
                        </details>
                      </li>
                    ))}
                  </ol>
                )}
      <div className="flex gap-2">
        {beforeGeneration !== undefined ? <Button onClick={() => setBeforeGeneration(undefined)}><Trans>Newest</Trans></Button> : null}
        {history.data?.nextGeneration != null ? <Button onClick={() => setBeforeGeneration(history.data?.nextGeneration ?? undefined)}><Trans>Older changes</Trans></Button> : null}
      </div>
    </Card>
  )
}
