'use client'

import { useId, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import type { NumericReportView } from './report-view'

type Configuration = 'default' | 'current' | 'candidate'
const levels = { wake: 0, rem: 1, light: 2, deep: 3 } as const

function TracePage({ id, hash, cohortId, configuration }: { id: string, hash: string, cohortId: string, configuration: Configuration }) {
  const { t, i18n } = useLingui()
  const titleId = useId()
  const [offsets, setOffsets] = useState([0])
  const offset = offsets[offsets.length - 1]
  const timeFormat = useTimeFormat()
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  const trace = trpc.biometricTuning.getBacktestTrace.useQuery({ id, expectedContentHash: hash, cohortId, configuration, offset, limit: 200 }, { staleTime: 60000 })
  let timezone = settings.data?.device.timezone ?? 'UTC'
  let dates: Intl.DateTimeFormat
  try {
    dates = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  catch {
    timezone = 'UTC'
    dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  const labels = { wake: t`Wake`, light: t`Light`, deep: t`Deep`, rem: t`REM` }
  if (trace.error) return <InlineError>{trace.error.message}</InlineError>
  if (!trace.data) return <Skeleton className="h-32" />
  const data = trace.data
  if (data.contentHash !== hash || data.configuration !== configuration || data.items.some(item => item.cohortId !== cohortId)) return <InlineError><Trans>Trace identity does not match the selected report.</Trans></InlineError>
  const start = Math.min(...data.items.map(item => item.startMs)), end = Math.max(...data.items.map(item => item.endMs))
  const x = (time: number) => 90 + (time - start) / Math.max(1, end - start) * 690
  const first = data.items.length ? offset + 1 : 0, last = offset + data.items.length
  return (
    <div className="space-y-3">
      <p>{t`Trace intervals ${first}–${last} of ${data.totalItems}`}</p>
      <p><Trans>This chart shows only the current page of replay intervals. Gaps are left empty; no stages are inferred between intervals.</Trans></p>
      <p>{t`Original trace timestamps are shown. Reference scoring adds the frozen offset of ${data.clockOffsetMs} ms to these timestamps.`}</p>
      <p>{t`Times shown in ${timezone}`}</p>
      {data.items.length
        ? (
            <>
              <svg viewBox="0 0 800 180" className="w-full" role="img" aria-labelledby={titleId}>
                <title id={titleId}><Trans>Stage trace for the displayed intervals; exact times and stages follow in the table.</Trans></title>
                {(['wake', 'rem', 'light', 'deep'] as const).map(stage => <text key={stage} x="0" y={30 + levels[stage] * 40} className="fill-current text-xs">{labels[stage]}</text>)}
                {data.items.map((item, index) => <line key={index} x1={x(item.startMs)} x2={x(item.endMs)} y1={25 + levels[item.stage] * 40} y2={25 + levels[item.stage] * 40} stroke="currentColor" strokeWidth="5" />)}
              </svg>
              <p>
                {dates.format(start)}
                {' – '}
                {dates.format(end)}
              </p>
              <details>
                <summary><Trans>Exact trace intervals</Trans></summary>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="text-left"><Trans>Original replay timestamps, without reference clock adjustment</Trans></caption>
                    <thead>
                      <tr>
                        <th scope="col"><Trans>Start</Trans></th>
                        <th scope="col"><Trans>End</Trans></th>
                        <th scope="col"><Trans>Stage</Trans></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item, index) => (
                        <tr key={index}>
                          <td><time dateTime={new Date(item.startMs).toISOString()}>{dates.format(item.startMs)}</time></td>
                          <td><time dateTime={new Date(item.endMs).toISOString()}>{dates.format(item.endMs)}</time></td>
                          <td>{labels[item.stage]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="break-all text-xs">{data.items[0].configurationHash}</p>
                </div>
              </details>
            </>
          )
        : <p><Trans>No stage intervals were produced for this selection.</Trans></p>}
      <div className="flex gap-2">
        <Button disabled={offsets.length === 1} onClick={() => setOffsets(offsets.slice(0, -1))}><Trans>Previous trace page</Trans></Button>
        <Button
          disabled={!data.nextCursor}
          onClick={() => {
            if (data.nextCursor?.contentHash === hash) setOffsets([...offsets, data.nextCursor.offset])
          }}
        >
          <Trans>Next trace page</Trans>
        </Button>
      </div>
    </div>
  )
}

export function StageTrace({ id, hash, nights }: { id: string, hash: string, nights: NumericReportView['nights'] }) {
  const { t } = useLingui()
  const [selectedNight, setSelectedNight] = useState(nights[0]?.cohortId ?? '')
  const [configuration, setConfiguration] = useState<Configuration>('default')
  const labels = { default: t`System defaults`, current: t`Current stage view`, candidate: t`Candidate` }
  const night = nights.find(item => item.cohortId === selectedNight)
  const selectedConfiguration = night?.evaluations.some(item => item.label === configuration) ? configuration : night?.evaluations[0]?.label
  return (
    <section className="space-y-3">
      <h4 className="font-medium"><Trans>Replay stage traces</Trans></h4>
      <label className="block">
        <Trans>Trace night</Trans>
        <select className="block" value={selectedNight} onChange={event => setSelectedNight(event.target.value)}>{nights.map(item => <option key={item.cohortId} value={item.cohortId}>{item.cohortId}</option>)}</select>
      </label>
      <label className="block">
        <Trans>Trace configuration</Trans>
        <select className="block" value={selectedConfiguration ?? ''} onChange={event => setConfiguration(event.target.value as Configuration)}>{night?.evaluations.map(item => <option key={item.label} value={item.label}>{labels[item.label]}</option>)}</select>
      </label>
      {night && selectedConfiguration ? <TracePage key={`${hash}:${selectedNight}:${selectedConfiguration}`} id={id} hash={hash} cohortId={selectedNight} configuration={selectedConfiguration} /> : <p><Trans>No evaluated configuration is available.</Trans></p>}
    </section>
  )
}
