'use client'

import { ReferenceOverlay } from './ReferenceOverlay'
import { useId, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import type { NumericReportView } from './report-view'

type Configuration = 'default' | 'current' | 'candidate'
type Metric = 'heartRate' | 'breathingRate' | 'hrvIndex'
function NumericTracePage({ id, hash, cohortId, configuration, configHash }: {
  id: string
  hash: string
  cohortId: string
  configuration: Configuration
  configHash: string
}) {
  const { t, i18n } = useLingui()
  const titleId = useId()
  const [offsets, setOffsets] = useState([0])
  const [showReferences, setShowReferences] = useState(false)
  const [metric, setMetric] = useState<Metric>('heartRate')
  const offset = offsets[offsets.length - 1]
  const timeFormat = useTimeFormat()
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  const trace = trpc.biometricTuning.getBacktestNumericTrace.useQuery({ id, expectedContentHash: hash, cohortId, configuration, offset, limit: 200 }, { staleTime: 60000 })
  let timezone = settings.data?.device.timezone ?? 'UTC'
  let dates: Intl.DateTimeFormat
  try {
    dates = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  catch {
    timezone = 'UTC'
    dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  const metrics = { heartRate: t`Heart rate (bpm)`, breathingRate: t`Breathing rate (breaths/min)`, hrvIndex: t`Window IBI variability index (ms)` }
  const number = (value: number | null) => value === null ? t`Missing` : new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 3 }).format(value)
  if (trace.error) return <InlineError>{trace.error.message}</InlineError>
  if (!trace.data) return <Skeleton className="h-32" />
  const data = trace.data
  if (data.jobId !== id || data.contentHash !== hash || data.configuration !== configuration || data.offset !== offset
    || data.items.some(item => item.cohortId !== cohortId || item.configHash !== configHash || item.side !== data.side)) {
    return <InlineError><Trans>Numeric trace identity does not match the selected report.</Trans></InlineError>
  }
  const points = data.items.flatMap(item => item[metric] === null ? [] : [{ timestamp: item.timestampMs, value: item[metric] }])
  const start = Math.min(...data.items.map(item => item.timestampMs)), end = Math.max(...data.items.map(item => item.timestampMs))
  const low = Math.min(...points.map(point => point.value)), high = Math.max(...points.map(point => point.value))
  const first = data.items.length ? offset + 1 : 0
  const next = data.nextCursor
  const canAdvance = next !== null && next.contentHash === hash && next.offset === offset + data.items.length && next.offset > offset && next.offset < data.totalItems
  return (
    <div className="space-y-3">
      <p>{t`Recomputed readings ${first}–${offset + data.items.length} of ${data.totalItems}`}</p>
      <p><Trans>Only the current page is plotted. Dots represent individual readings; gaps and missing values are not interpolated. Original stored readings remain unchanged.</Trans></p>
      <p>{t`Original timestamps are shown in ${timezone}. Reference scoring adds the frozen offset of ${data.clockOffsetMs} ms.`}</p>
      <label className="block">
        <Trans>Numeric trace metric</Trans>
        <select className="block" value={metric} onChange={event => setMetric(event.target.value as Metric)}>
          {Object.entries(metrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      {points.length
        ? (
            <svg viewBox="0 0 800 200" className="w-full" role="img" aria-labelledby={titleId}>
              <title id={titleId}>{t`Recomputed ${metrics[metric]}; exact readings follow in the table.`}</title>
              <text x="0" y="20" className="fill-current text-xs">{number(high)}</text>
              <text x="0" y="175" className="fill-current text-xs">{number(low)}</text>
              {points.map((point, index) => (
                <circle
                  key={index}
                  cx={70 + (point.timestamp - start) / Math.max(1, end - start) * 700}
                  cy={high === low ? 95 : 175 - (point.value - low) / (high - low) * 155}
                  r="3"
                  fill="currentColor"
                />
              ))}
            </svg>
          )
        : <p><Trans>No values for this metric on the current page.</Trans></p>}
      {data.items.length
        ? (
            <p>
              {dates.format(start)}
              {' – '}
              {dates.format(end)}
            </p>
          )
        : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="text-left"><Trans>Exact recomputed readings, without reference clock adjustment</Trans></caption>
          <thead>
            <tr>
              <th scope="col"><Trans>Time</Trans></th>
              <th scope="col">{metrics[metric]}</th>
              <th scope="col"><Trans>Quality</Trans></th>
              <th scope="col"><Trans>Source channel</Trans></th>
              <th scope="col"><Trans>Flags</Trans></th>
              <th scope="col"><Trans>Limitations</Trans></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, index) => (
              <tr key={index}>
                <td><time dateTime={new Date(item.timestampMs).toISOString()}>{dates.format(item.timestampMs)}</time></td>
                <td>{number(item[metric])}</td>
                <td>{number(item.qualityScore)}</td>
                <td>{item.sourceSide === 'left' ? t`Left` : t`Right`}</td>
                <td>{item.flags === null ? t`Unknown` : item.flags.join(', ') || t`None`}</td>
                <td>{item.limitations.join(', ') || t`None`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button onClick={() => setShowReferences(!showReferences)} aria-expanded={showReferences}><Trans>Compare frozen references</Trans></Button>
      {showReferences
        ? (
            <ReferenceOverlay
              key={`${metric}:${offset}`}
              id={id}
              hash={hash}
              cohortId={cohortId}
              metric={metric === 'heartRate' ? 'heart_rate' : metric === 'breathingRate' ? 'breathing_rate' : 'window_ibi_variability_v1'}
              clockOffsetMs={data.clockOffsetMs}
              points={points}
            />
          )
        : null}
      <p className="break-all text-xs">{configHash}</p>
      <div className="flex gap-2">
        <Button disabled={offsets.length === 1} onClick={() => setOffsets(offsets.slice(0, -1))}><Trans>Previous numeric page</Trans></Button>
        <Button disabled={!canAdvance} onClick={() => { if (canAdvance && next) setOffsets([...offsets, next.offset]) }}><Trans>Next numeric page</Trans></Button>
      </div>
    </div>
  )
}

export function NumericTrace({ id, hash, nights }: { id: string, hash: string, nights: NumericReportView['nights'] }) {
  const { t } = useLingui()
  const [cohortId, setCohortId] = useState(nights[0]?.cohortId ?? '')
  const [configuration, setConfiguration] = useState<Configuration>('default')
  const night = nights.find(item => item.cohortId === cohortId)
  const selected = night?.evaluations.find(item => item.label === configuration) ?? night?.evaluations[0]
  const labels = { default: t`System defaults`, current: t`Current baseline`, candidate: t`Candidate` }
  return (
    <section className="space-y-3">
      <h4 className="font-medium"><Trans>Recomputed numeric traces</Trans></h4>
      <label className="block">
        <Trans>Numeric trace night</Trans>
        <select className="block" value={cohortId} onChange={event => setCohortId(event.target.value)}>
          {nights.map(item => <option key={item.cohortId} value={item.cohortId}>{item.cohortId}</option>)}
        </select>
      </label>
      <label className="block">
        <Trans>Numeric trace configuration</Trans>
        <select className="block" value={selected?.label ?? ''} onChange={event => setConfiguration(event.target.value as Configuration)}>
          {night?.evaluations.map(item => <option key={item.label} value={item.label}>{labels[item.label]}</option>)}
        </select>
      </label>
      {selected ? <NumericTracePage key={`${hash}:${cohortId}:${selected.label}`} id={id} hash={hash} cohortId={cohortId} configuration={selected.label} configHash={selected.configHash} /> : <p><Trans>No evaluated configuration is available.</Trans></p>}
    </section>
  )
}
