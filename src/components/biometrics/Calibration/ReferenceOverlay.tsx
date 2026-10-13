'use client'
import { useId, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'

export function ReferenceOverlay({ id, hash, cohortId, metric, clockOffsetMs, points }: {
  id: string
  hash: string
  cohortId: string
  metric: 'heart_rate' | 'breathing_rate' | 'window_ibi_variability_v1'
  clockOffsetMs: number
  points: Array<{ timestamp: number, value: number }>
}) {
  const { t } = useLingui()
  const titleId = useId()
  const [offsets, setOffsets] = useState([0])
  const offset = offsets[offsets.length - 1]
  const query = trpc.biometricTuning.getBacktestReferenceTrace.useQuery({ id, expectedContentHash: hash, cohortId, metric, offset, limit: 200 }, { staleTime: 60000 })
  if (query.error) return <InlineError>{query.error.message}</InlineError>
  if (!query.data) return <Skeleton className="h-32" />
  const data = query.data
  if (data.jobId !== id || data.contentHash !== hash || data.cohortId !== cohortId || data.metric !== metric || data.offset !== offset || data.clockOffsetMs !== clockOffsetMs) {
    return <InlineError><Trans>Reference identity does not match the selected report.</Trans></InlineError>
  }
  const references = data.items.flatMap(row => row.compatibility === null && row.value !== null ? [{ ...row, value: row.value }] : [])
  const shifted = points.map(point => ({ ...point, timestamp: point.timestamp + clockOffsetMs }))
  const times = [...shifted.map(point => point.timestamp), ...references.flatMap(row => [row.startMs, row.endMs])]
  const values = [...shifted.map(point => point.value), ...references.map(row => row.value)]
  const start = Math.min(...times), end = Math.max(...times), low = Math.min(...values), high = Math.max(...values)
  const x = (time: number) => 60 + (time - start) / Math.max(1, end - start) * 720
  const y = (value: number) => high === low ? 90 : 165 - (value - low) / (high - low) * 140
  const next = data.nextCursor
  const canAdvance = next !== null && next.contentHash === hash && next.offset === offset + data.items.length && next.offset > offset && next.offset < data.totalItems
  return (
    <section className="space-y-3">
      <h5><Trans>Frozen reference overlay</Trans></h5>
      <p><Trans>Circles are recomputed readings; squares are reference points; horizontal bars are reference intervals. Only the two displayed pages are shown. This visual overlay does not create new matched pairs or scores.</Trans></p>
      <p>{t`The frozen offset of ${clockOffsetMs} ms is added to recomputed timestamps in this overlay. Reference times stay unchanged. Point matching tolerance: ${data.pointToleranceMs} ms.`}</p>
      {values.length
        ? (
            <>
              <svg viewBox="0 0 800 190" className="w-full" role="img" aria-labelledby={titleId}>
                <title id={titleId}><Trans>Recomputed readings and compatible frozen references in the selected metric unit</Trans></title>
                <text x="0" y="20" className="fill-current text-xs">{high.toFixed(2)}</text>
                <text x="0" y="170" className="fill-current text-xs">{low.toFixed(2)}</text>
                {shifted.map((point, index) => <circle key={`pod:${index}`} cx={x(point.timestamp)} cy={y(point.value)} r="3" fill="currentColor" />)}
                {references.map((row, index) => row.temporalKind === 'point'
                  ? <rect key={`ref:${index}`} x={x(row.startMs) - 4} y={y(row.value) - 4} width="8" height="8" fill="none" stroke="currentColor" />
                  : <line key={`ref:${index}`} x1={x(row.startMs)} x2={x(row.endMs)} y1={y(row.value)} y2={y(row.value)} stroke="currentColor" strokeWidth="3" />)}
              </svg>
              <p>
                {new Date(start).toISOString()}
                {' – '}
                {new Date(end).toISOString()}
              </p>
            </>
          )
        : <p><Trans>No compatible values on these pages.</Trans></p>}
      <p>{t`Reference records ${data.items.length ? offset + 1 : 0}–${offset + data.items.length} of ${data.totalItems}`}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption><Trans>Frozen source records in UTC; incompatible records are listed but not plotted</Trans></caption>
          <thead>
            <tr>
              <th scope="col"><Trans>Source / revision</Trans></th>
              <th scope="col"><Trans>Start</Trans></th>
              <th scope="col"><Trans>End</Trans></th>
              <th scope="col"><Trans>Value / unit</Trans></th>
              <th scope="col"><Trans>Aggregation</Trans></th>
              <th scope="col"><Trans>Compatibility</Trans></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row, index) => (
              <tr key={index}>
                <td>
                  {row.source}
                  {' / '}
                  {row.importRevision}
                </td>
                <td>{new Date(row.startMs).toISOString()}</td>
                <td>{row.temporalKind === 'point' ? t`Point` : new Date(row.endMs).toISOString()}</td>
                <td>
                  {row.value ?? t`Missing`}
                  {' '}
                  {row.unit}
                </td>
                <td>{row.aggregation}</td>
                <td>{row.compatibility ?? t`Compatible`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button disabled={offsets.length === 1} onClick={() => setOffsets(offsets.slice(0, -1))}><Trans>Previous reference page</Trans></Button>
        <Button disabled={!canAdvance} onClick={() => { if (canAdvance && next) setOffsets([...offsets, next.offset]) }}><Trans>Next reference page</Trans></Button>
      </div>
    </section>
  )
}
