'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'

export function ReplaySessionPicker({ side, selected, onChange }: { side: 'left' | 'right', selected: number[], onChange: (ids: number[]) => void }) {
  const { t, i18n } = useLingui()
  const timeFormat = useTimeFormat()
  const [cursor, setCursor] = useState<{ startMs: number, id: number }>()
  const [inspected, setInspected] = useState<number>()
  const sessions = trpc.biometricTuning.listSessions.useQuery({ side, beforeStartMs: cursor?.startMs, beforeId: cursor?.id })
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  const timezone = settings.data?.device.timezone ?? 'UTC'
  let dates: Intl.DateTimeFormat
  try {
    dates = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  catch { dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC', hour12: timeFormat !== '24h' }) }
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Recorded nights</Trans>} subtitle={<Trans>Inspect available data before selecting nights for a retained dataset.</Trans>} />
      <p>{t`Times shown in ${dates.resolvedOptions().timeZone}`}</p>
      <p>{t`Selected sessions: ${selected.length} / 60`}</p>
      {selected.length > 0 ? <div className="flex flex-wrap gap-2">{selected.map(id => <Button key={id} onClick={() => onChange(selected.filter(value => value !== id))}>{t`Remove session ${id}`}</Button>)}</div> : null}
      {sessions.error
        ? <InlineError>{sessions.error.message}</InlineError>
        : !sessions.data
            ? <Skeleton className="h-32" />
            : (
                <>
                  {sessions.data.items.length === 0 ? <p><Trans>No recorded nights for this side.</Trans></p> : null}
                  <ul className="space-y-3">
                    {sessions.data.items.map(session => (
                      <li key={session.id} className="space-y-2 border-b border-border pb-3">
                        <p>
                          {dates.format(session.startMs)}
                          {' — '}
                          {dates.format(session.endMs)}
                        </p>
                        <Button aria-expanded={inspected === session.id} onClick={() => setInspected(inspected === session.id ? undefined : session.id)}>{t`Inspect session ${session.id}`}</Button>
                        {inspected === session.id ? <SessionCapabilities key={session.id} side={side} id={session.id} selected={selected.includes(session.id)} limitReached={selected.length >= 60} onSelect={checked => onChange(checked ? [...selected, session.id] : selected.filter(id => id !== session.id))} /> : null}
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest nights</Trans></Button> : null}
                    {sessions.data.nextCursor ? <Button onClick={() => setCursor(sessions.data?.nextCursor ?? undefined)}><Trans>Older nights</Trans></Button> : null}
                  </div>
                </>
              )}
    </Card>
  )
}
function SessionCapabilities({ side, id, selected, limitReached, onSelect }: { side: 'left' | 'right', id: number, selected: boolean, limitReached: boolean, onSelect: (checked: boolean) => void }) {
  const { t } = useLingui()
  const query = trpc.biometricTuning.getSessionCapabilities.useQuery({ side, id })
  if (query.error) return <InlineError>{query.error.message}</InlineError>
  if (!query.data) return <Skeleton className="h-24" />
  const data = query.data
  return (
    <div className="space-y-2 text-sm">
      <p>{data.comparison ? <Trans>Stored-reading comparison available</Trans> : <Trans>No stored vitals for comparison</Trans>}</p>
      <p>{data.stageReplay ? <Trans>Stage replay available</Trans> : <Trans>Stage replay unavailable</Trans>}</p>
      <p><Trans>Signal replay unavailable: raw waveforms and processing context have not been retained by this service.</Trans></p>
      <p>{t`Vitals with unknown original processing provenance: ${data.processed.legacyUnknownProvenanceCount}`}</p>
      <p>{t`Stored vitals: ${data.processed.vitals.count}; movement records: ${data.processed.movement.count}`}</p>
      <p><Trans>Coverage estimates use nominal recording cadence; they do not prove continuous signal support.</Trans></p>
      <details>
        <summary><Trans>Exact processed-data coverage</Trans></summary>
        <pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(data.processed, null, 2)}</pre>
      </details>
      <p><Trans>Available reference records by metric (across revisions)</Trans></p>
      {data.referenceMetrics.length === 0
        ? <p><Trans>No overlapping reference records.</Trans></p>
        : (
            <ul>
              {data.referenceMetrics.map(metric => (
                <li key={metric.metric}>
                  {metric.metric}
                  {': '}
                  {metric.count}
                </li>
              ))}
            </ul>
          )}
      {data.limitations.map(limitation => <p key={limitation} className="text-fg-2">{limitation}</p>)}
      <label className="block">
        <input type="checkbox" checked={selected} disabled={!selected && (!data.comparison || limitReached)} onChange={event => onSelect(event.target.checked)} />
        {' '}
        <Trans>Include this session</Trans>
      </label>
    </div>
  )
}
