'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { CalibrationReferences } from './CalibrationReferences'
import { ReferenceTimeSpan } from './ReferenceTimeSpan'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'

export function ReferenceLibrary({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [selected, setSelected] = useState<string>()
  const [correcting, setCorrecting] = useState<string>()
  const [deleting, setDeleting] = useState<string>()
  const imports = trpc.biometricTuning.listImports.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id })
  const remove = trpc.biometricTuning.deleteImport.useMutation()
  const utils = trpc.useUtils()
  async function deleteSelected(id: string) {
    await remove.mutateAsync({ id })
    setDeleting(undefined)
    if (correcting === id) setCorrecting(undefined)
    if (selected === id) setSelected(undefined)
    await utils.biometricTuning.listImports.invalidate()
  }
  return (
    <Card className="space-y-4">
      <CardHeader title={<Trans>Reference library</Trans>} subtitle={<Trans>Deleting an import removes its source measurements. Previously frozen datasets are separate retained copies.</Trans>} />
      {imports.error
        ? <InlineError>{imports.error.message}</InlineError>
        : !imports.data
            ? <Skeleton className="h-32" />
            : (
                <>
                  {imports.data.items.length === 0 ? <p><Trans>No reference imports for this side.</Trans></p> : null}
                  <ul className="space-y-4">
                    {imports.data.items.map(item => (
                      <li key={item.id} className="space-y-2 border-b border-border pb-3">
                        <p>
                          <strong>{item.summary.source}</strong>
                          {' — '}
                          {item.summary.subjectId}
                        </p>
                        <p>{t`Revision ${item.revision}; accepted ${item.summary.accepted}; unscorable ${item.summary.unscorable}`}</p>
                        <ReferenceTimeSpan startMs={item.summary.startMs} endMs={item.summary.endMs} />
                        <p className="break-all text-xs">{item.id}</p>
                        {item.available
                          ? (
                              <div className="flex flex-wrap gap-2">
                                <Button onClick={() => setSelected(selected === item.id ? undefined : item.id)} aria-expanded={selected === item.id}><Trans>Inspect measurements</Trans></Button>
                                <Button aria-expanded={correcting === item.id} onClick={() => setCorrecting(correcting === item.id ? undefined : item.id)}><Trans>Correct import</Trans></Button>
                                <Button disabled={remove.isPending} onClick={() => setDeleting(item.id)}><Trans>Delete import</Trans></Button>
                              </div>
                            )
                          : <p><Trans>Source measurements deleted</Trans></p>}
                        {deleting === item.id
                          ? (
                              <div className="space-y-2" role="group" aria-label={t`Confirm import deletion`}>
                                <p><Trans>Delete these source measurements permanently? Retained dataset copies must be released separately.</Trans></p>
                                <Button disabled={remove.isPending} onClick={() => void deleteSelected(item.id).catch(() => {})}><Trans>Permanently delete import</Trans></Button>
                                <Button disabled={remove.isPending} onClick={() => setDeleting(undefined)}><Trans>Keep import</Trans></Button>
                              </div>
                            )
                          : null}
                        {correcting === item.id && item.available ? <CalibrationReferences key={item.id} side={side} correction={{ id: item.id, subjectId: item.summary.subjectId, source: item.summary.source }} /> : null}
                        {selected === item.id && item.available ? <ReferenceMeasurements key={item.id} id={item.id} /> : null}
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest imports</Trans></Button> : null}
                    {imports.data.nextCursor ? <Button onClick={() => setCursor(imports.data?.nextCursor ?? undefined)}><Trans>Older imports</Trans></Button> : null}
                  </div>
                </>
              )}
      {remove.error ? <InlineError>{remove.error.message}</InlineError> : null}
    </Card>
  )
}

function ReferenceMeasurements({ id }: { id: string }) {
  const [afterId, setAfterId] = useState(0)
  const records = trpc.biometricTuning.getImportMeasurements.useQuery({ id, afterId, limit: 100 })
  if (records.error) return <InlineError>{records.error.message}</InlineError>
  if (!records.data) return <Skeleton className="h-32" />
  return (
    <div className="space-y-2">
      <p className="text-sm text-fg-2"><Trans>Exact normalized timestamps are shown in UTC. Values are not interpolated.</Trans></p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="text-left"><Trans>Normalized reference measurements</Trans></caption>
          <thead>
            <tr>
              <th scope="col"><Trans>Metric</Trans></th>
              <th scope="col"><Trans>Value</Trans></th>
              <th scope="col"><Trans>Start (UTC)</Trans></th>
              <th scope="col"><Trans>End (UTC)</Trans></th>
              <th scope="col"><Trans>Validation exclusions</Trans></th>
            </tr>
          </thead>
          <tbody>
            {records.data.items.map(row => (
              <tr key={row.id}>
                <td>{row.metric}</td>
                <td>
                  {row.stage ?? row.value ?? '—'}
                  {' '}
                  {row.unit}
                </td>
                <td>{new Date(row.startMs).toISOString()}</td>
                <td>{new Date(row.endMs).toISOString()}</td>
                <td>{row.exclusions.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {records.data.items.length === 0 ? <p><Trans>No retained measurements.</Trans></p> : null}
      {afterId > 0 ? <Button onClick={() => setAfterId(0)}><Trans>First records</Trans></Button> : null}
      {records.data.nextCursor !== null ? <Button onClick={() => setAfterId(records.data?.nextCursor ?? 0)}><Trans>Next records</Trans></Button> : null}
    </div>
  )
}
