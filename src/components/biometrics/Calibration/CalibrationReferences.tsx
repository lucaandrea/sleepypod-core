'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds'
import { ReferenceTimeSpan } from './ReferenceTimeSpan'
import { parseReferenceText } from '@/src/biometrics/references/parse'
import type { PreviewSummary, ReferenceImportInput } from '@/src/biometrics/references/contracts'

export function CalibrationReferences({ side, correction }: { side: 'left' | 'right', correction?: { id: string, subjectId: string, source: string } }) {
  const { t } = useLingui()
  const [subjectId, setSubjectId] = useState(correction?.subjectId ?? '')
  const [source, setSource] = useState(correction?.source ?? '')
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<{ input: ReferenceImportInput, summary: PreviewSummary }>()
  const [acceptRejected, setAcceptRejected] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const utils = trpc.useUtils()
  const previewImport = trpc.biometricTuning.previewImport.useMutation()
  const commitImport = trpc.biometricTuning.commitImport.useMutation()
  const busy = previewImport.isPending || commitImport.isPending
  function invalidate() {
    setPreview(undefined)
    setAcceptRejected(false)
    setError(undefined)
    setSaved(undefined)
  }
  async function inspect() {
    invalidate()
    try {
      const input = { side, subjectId, source, rows: parseReferenceText(format, text) }
      const summary = await previewImport.mutateAsync(input)
      setPreview({ input, summary })
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t`Reference preview failed.`) }
  }
  async function save() {
    if (!preview) return
    setError(undefined)
    try {
      const result = await commitImport.mutateAsync({ import: preview.input, previewHash: preview.summary.contentHash, acceptRejectedRows: acceptRejected, ...(correction ? { supersedesImportId: correction.id } : {}) })
      setSaved(result.id)
      void utils.biometricTuning.listImports.invalidate()
      setPreview(undefined)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t`Reference import failed.`) }
  }
  return (
    <Card className="space-y-4">
      <CardHeader title={<Trans>Import reference measurements</Trans>} subtitle={<Trans>Preview normalized records before saving them on the pod.</Trans>} />
      <p className="text-sm text-fg-2"><Trans>Use offset-bearing ISO timestamps or Unix milliseconds. Each record needs recordKey, metric, value, unit, and timestamp (or start and end). JSON uses an array; CSV uses these field names as headers. Imports are limited to 2 MiB and 2000 records.</Trans></p>
      {correction ? <p role="status">{t`Correcting import ${correction.id}. Supply the complete replacement export; the original revision and frozen datasets remain unchanged.`}</p> : null}
      <pre className="overflow-x-auto text-xs">{'recordKey,metric,value,unit,timestamp\n1,heart_rate,60,bpm,2026-10-10T23:00:00Z'}</pre>
      <fieldset disabled={busy || Boolean(correction && saved)} className="space-y-3" onChange={invalidate}>
        <label className="block">
          <Trans>Sleeper identifier</Trans>
          <input className="block w-full rounded border p-2" value={subjectId} readOnly={Boolean(correction)} maxLength={200} onChange={event => setSubjectId(event.target.value)} />
        </label>
        <label className="block">
          <Trans>Reference source</Trans>
          <input className="block w-full rounded border p-2" value={source} readOnly={Boolean(correction)} maxLength={120} onChange={event => setSource(event.target.value)} />
        </label>
        <label className="block">
          <Trans>Data format</Trans>
          <select className="ml-2 rounded border p-2" value={format} onChange={event => setFormat(event.target.value as 'csv' | 'json')}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label className="block">
          <Trans>Reference records</Trans>
          <textarea className="block min-h-40 w-full rounded border p-2 font-mono text-sm" value={text} onChange={event => setText(event.target.value)} />
        </label>
      </fieldset>
      <Button disabled={busy || Boolean(correction && saved) || !subjectId.trim() || !source.trim() || !text.trim()} onClick={() => void inspect()}><Trans>Preview import</Trans></Button>
      {error ? <InlineError>{error}</InlineError> : null}
      {saved ? <p role="status">{t`Reference import saved: ${saved}`}</p> : null}
      {preview
        ? (
            <section aria-label={t`Import preview`} className="space-y-3">
              <p>{t`Accepted: ${preview.summary.accepted}; rejected: ${preview.summary.rejected}; duplicates: ${preview.summary.duplicates}; unscorable: ${preview.summary.unscorable}; conflicts: ${preview.summary.conflicts}`}</p>
              <ReferenceTimeSpan startMs={preview.summary.startMs} endMs={preview.summary.endMs} />
              <p>{t`Metrics: ${preview.summary.metrics.join(', ')}`}</p>
              <p className="text-sm text-fg-2"><Trans>Accepted records are not necessarily usable for validation. Incompatible HRV definitions remain unscorable.</Trans></p>
              {preview.summary.warnings.map(warning => <p key={warning}>{warning}</p>)}
              <ul>{preview.summary.rejectionExamples.map((item, index) => <li key={index}>{t`Row ${item.row}: ${item.message}`}</li>)}</ul>
              <details>
                <summary><Trans>Exact import identity</Trans></summary>
                <p className="break-all font-mono text-xs">{preview.summary.contentHash}</p>
              </details>
              {preview.summary.rejected > 0
                ? (
                    <label className="block">
                      <input type="checkbox" checked={acceptRejected} disabled={busy} onChange={event => setAcceptRejected(event.target.checked)} />
                      {' '}
                      <Trans>Import accepted records and omit rejected records</Trans>
                    </label>
                  )
                : null}
              <Button disabled={busy || preview.summary.accepted === 0 || (preview.summary.rejected > 0 && !acceptRejected)} onClick={() => void save()}><Trans>Save previewed import</Trans></Button>
            </section>
          )
        : null}
    </Card>
  )
}
