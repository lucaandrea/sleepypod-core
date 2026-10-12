'use client'

import { useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'
import { ReplaySessionPicker } from './ReplaySessionPicker'

interface ReferenceSelection { id: string, familyId: string }
export function DatasetBuilder({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const [sessions, setSessions] = useState<number[]>([])
  const [subjectId, setSubjectId] = useState('')
  const [references, setReferences] = useState<ReferenceSelection[]>([])
  const [savedSelection, setSavedSelection] = useState<string>()
  const request = useRef<{ fingerprint: string, key: string } | undefined>(undefined)
  const create = trpc.biometricTuning.createDataset.useMutation()
  const utils = trpc.useUtils()
  const input = { side, subjectId: subjectId.trim(), sessionIds: [...sessions].sort((a, b) => a - b), referenceImportIds: references.map(item => item.id).sort() }
  const splitLabels = { tuning: t`Tuning`, validation: t`Validation`, holdout: t`Holdout` }
  const fingerprint = JSON.stringify(input)
  async function freeze() {
    if (!request.current || request.current.fingerprint !== fingerprint) request.current = { fingerprint, key: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('') }
    await create.mutateAsync({ ...input, idempotencyKey: request.current.key })
    setSavedSelection(fingerprint)
    void utils.biometricTuning.listDatasets.invalidate({ side })
  }
  return (
    <div className="space-y-4">
      <fieldset disabled={create.isPending} className="space-y-4">
        <ReplaySessionPicker side={side} selected={sessions} onChange={setSessions} />
        <Card className="space-y-3">
          <CardHeader title={<Trans>Freeze evaluation inputs</Trans>} subtitle={<Trans>Retain a copy of the selected nights and reference revisions. Future edits or source deletion do not alter this dataset.</Trans>} />
          <label className="block">
            <Trans>Dataset sleeper identifier</Trans>
            <input
              className="ml-2 rounded border p-2"
              maxLength={200}
              value={subjectId}
              onChange={(event) => {
                setSubjectId(event.target.value)
                setReferences([])
              }}
            />
          </label>
          <DatasetReferences key={subjectId.trim()} side={side} subjectId={subjectId.trim()} selected={references} onChange={setReferences} />
          {references.length === 0 ? <p><Trans>No references selected. This dataset cannot establish agreement with reference measurements.</Trans></p> : null}
          <p><Trans>The server groups connected sessions into whole nights in the device timezone before assigning tuning, validation, and holdout sets. A split is not evidence of improvement.</Trans></p>
          <Button disabled={sessions.length === 0 || !subjectId.trim() || savedSelection === fingerprint} onClick={() => void freeze().catch(() => {})}><Trans>Freeze selected inputs</Trans></Button>
          {create.error ? <InlineError>{create.error.message}</InlineError> : null}
        </Card>
      </fieldset>
      {create.data
        ? (
            <Card className="space-y-3">
              <CardHeader title={<Trans>Frozen dataset</Trans>} />
              <p role="status">{t`Dataset saved: ${create.data.id}`}</p>
              <p className="break-all font-mono text-xs">{create.data.contentHash}</p>
              <p>{create.data.manifest.splitProtocol.evidence === 'descriptive_only' ? <Trans>Too few independent nights for a validation split; descriptive evaluation only.</Trans> : <Trans>Whole-night partitions assigned; biometric performance is not yet validated.</Trans>}</p>
              <ul>
                {create.data.manifest.splitProtocol.assignments.map(cohort => (
                  <li key={cohort.cohortId}>
                    {cohort.nightLabels.join(', ')}
                    {' — '}
                    {splitLabels[cohort.split]}
                  </li>
                ))}
              </ul>
              {create.data.manifest.splitProtocol.limitations.map(text => <p key={text}>{text}</p>)}
              {create.data.manifest.limitations.map(text => <p key={text}>{text}</p>)}
            </Card>
          )
        : null}
    </div>
  )
}
function DatasetReferences({ side, subjectId, selected, onChange }: { side: 'left' | 'right', subjectId: string, selected: ReferenceSelection[], onChange: (items: ReferenceSelection[]) => void }) {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const query = trpc.biometricTuning.listImports.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id })
  return (
    <div className="space-y-2">
      <p>{t`Selected reference revisions: ${selected.length} / 20`}</p>
      {selected.map(item => <Button key={item.id} onClick={() => onChange(selected.filter(value => value.id !== item.id))}>{t`Remove reference ${item.id}`}</Button>)}
      {query.error
        ? <InlineError>{query.error.message}</InlineError>
        : !query.data
            ? <Skeleton className="h-24" />
            : (
                <>
                  {query.data.items.length === 0 ? <p><Trans>No reference imports for this side.</Trans></p> : null}
                  <ul className="space-y-2">
                    {query.data.items.map((item) => {
                      const checked = selected.some(value => value.id === item.id)
                      const matches = item.available && item.summary.subjectId === subjectId
                      const familySelected = selected.some(value => value.familyId === item.familyId && value.id !== item.id)
                      return (
                        <li key={item.id}>
                          <label>
                            <input type="checkbox" checked={checked} disabled={!checked && (!matches || familySelected || selected.length >= 20)} onChange={event => onChange(event.target.checked ? [...selected, { id: item.id, familyId: item.familyId }] : selected.filter(value => value.id !== item.id))} />
                            {' '}
                            {t`${item.summary.source} · ${item.summary.subjectId} · revision ${item.revision}`}
                          </label>
                          {!matches ? <p className="text-xs"><Trans>Unavailable or belongs to a different sleeper.</Trans></p> : familySelected ? <p className="text-xs"><Trans>Another revision from this reference family is selected.</Trans></p> : null}
                        </li>
                      )
                    })}
                  </ul>
                  {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest imports</Trans></Button> : null}
                  {query.data.nextCursor ? <Button onClick={() => setCursor(query.data?.nextCursor ?? undefined)}><Trans>Older imports</Trans></Button> : null}
                </>
              )}
    </div>
  )
}
