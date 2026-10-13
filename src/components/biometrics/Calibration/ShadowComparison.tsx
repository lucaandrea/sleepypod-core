'use client'

import { useRef, useState } from 'react'
import type { z } from 'zod'
import type { shadowReportSchema } from '@/src/biometrics/shadow/report-contracts'
import { parseReferenceText } from '@/src/biometrics/references/parse'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, InlineError } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'

export function ShadowComparison({ id, side, subjectId }: { id: string, side: 'left' | 'right', subjectId: string }) {
  const { t, i18n } = useLingui()
  const [source, setSource] = useState('')
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [text, setText] = useState('')
  const [result, setResult] = useState<z.infer<typeof shadowReportSchema>>()
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  const compare = trpc.biometricShadow.compare.useMutation()
  function edit(change: () => void) {
    if (pending.current) return
    change()
    setResult(undefined)
    setError(undefined)
  }
  async function compareReference() {
    if (pending.current || !source.trim() || !text.trim()) return
    pending.current = true
    setResult(undefined)
    setError(undefined)
    try {
      if (new TextEncoder().encode(text).byteLength > 65536) throw new Error(t`Reference comparison is limited to a 64 KiB request.`)
      const reference = { side, subjectId, source, timePolicy: { disambiguation: 'reject' as const }, rows: parseReferenceText(format, text) }
      if (new TextEncoder().encode(JSON.stringify({ type: 'readShadowReport', input: { id, reference } })).byteLength > 65536) throw new Error(t`Reference comparison is limited to a 64 KiB request.`)
      setResult(await compare.mutateAsync({ id, reference }))
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t`Reference comparison failed.`) }
    finally { pending.current = false }
  }
  const number = new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 2 })
  const percent = new Intl.NumberFormat(i18n.locale || 'en', { style: 'percent', maximumFractionDigits: 1 })
  const value = (n: number | null | undefined) => n == null ? t`Unavailable` : number.format(n)
  const coverage = (n: number | null) => n === null ? t`Unavailable` : percent.format(n)
  const metrics = { heart_rate: t`Heart rate (bpm)`, breathing_rate: t`Breathing rate (breaths/min)`, window_ibi_variability_v1: t`Window IBI variability index (ms)` }
  const status = { no_reference: t`No reference records in the observation window.`, no_overlap: t`No matching observations.`, incompatible: t`Reference definitions are incompatible.`, compared: t`Reference agreement calculated.` }
  return (
    <section aria-label={t`Compare prospective observations with a reference`} className="space-y-3 border-t border-border pt-3">
      <h5><Trans>Compare with reference measurements</Trans></h5>
      <p>{t`Sleeper identity: ${subjectId}`}</p>
      <p><Trans>Paste JSON records or CSV with recordKey, metric, value, unit, and timestamp (or start and end). Use offset-bearing ISO times or Unix milliseconds. This comparison does not save a reference import.</Trans></p>
      <fieldset disabled={compare.isPending} className="space-y-3">
        <label className="block">
          <Trans>Reference source</Trans>
          <input className="block w-full rounded border p-2" maxLength={120} value={source} onChange={event => edit(() => setSource(event.target.value))} />
        </label>
        <label className="block">
          <Trans>Reference format</Trans>
          <select className="ml-2 rounded border p-2" value={format} onChange={event => edit(() => setFormat(event.target.value as 'csv' | 'json'))}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label className="block">
          <Trans>Comparison reference records</Trans>
          <textarea className="block min-h-32 w-full rounded border p-2 font-mono text-sm" maxLength={65536} value={text} onChange={event => edit(() => setText(event.target.value))} />
        </label>
        <p><Trans>Comparison requests are limited to 64 KiB and 2000 records.</Trans></p>
        <Button disabled={!source.trim() || !text.trim()} onClick={() => void compareReference()}><Trans>Compare reference</Trans></Button>
      </fieldset>
      {error ? <InlineError>{error}</InlineError> : null}
      {result
        ? (
            <div className="space-y-3">
              <h5><Trans>Reference comparison snapshot</Trans></h5>
              <p>{new Date(result.capturedAtMs).toISOString()}</p>
              <p><Trans>This comparison captures a fresh snapshot. An ongoing run may have more observations than the earlier health report.</Trans></p>
              {result.referenceSummary ? <p>{t`Accepted: ${result.referenceSummary.accepted}; rejected: ${result.referenceSummary.rejected}; duplicates: ${result.referenceSummary.duplicates}; unscorable: ${result.referenceSummary.unscorable}`}</p> : null}
              <p>{t`Reference records outside the captured window: ${result.excludedBoundaryReferences}`}</p>
              <p>{t`Reference clock offset: ${value(result.alignment.clockOffsetMs / 1000)} seconds; point tolerance: ${value(result.alignment.pointToleranceMs / 1000)} seconds.`}</p>
              {result.metrics.map(metric => (
                <div key={metric.metric} className="space-y-2">
                  <h6>{metrics[metric.metric]}</h6>
                  {metric.windowMs !== null ? <p>{t`Metric window: ${value(metric.windowMs / 1000)} seconds.`}</p> : null}
                  <p>{status[metric.comparison.commonSupport.candidate.status]}</p>
                  <p>{t`Shared reference pairs: active ${metric.comparison.commonSupport.baseline.pairedCount}, candidate ${metric.comparison.commonSupport.candidate.pairedCount}.`}</p>
                  <p>{t`Mean absolute error on shared timestamps: active ${value(metric.comparison.commonSupport.baseline.metrics?.mae)}, candidate ${value(metric.comparison.commonSupport.candidate.metrics?.mae)}.`}</p>
                  <p>{t`Reference coverage using each output: active ${coverage(metric.comparison.ownSupport.baseline.referenceCoverage)}, candidate ${coverage(metric.comparison.ownSupport.candidate.referenceCoverage)}.`}</p>
                  <p>{t`Candidate observation timestamps lost: ${metric.comparison.lostObservationTimestamps}; added: ${metric.comparison.addedObservationTimestamps}.`}</p>
                  {metric.comparison.coverageReduced ? <p><Trans>Candidate coverage was reduced; lower error alone does not show improvement.</Trans></p> : null}
                  {Object.values(metric.referenceExclusions).some(count => count > 0) ? <p><Trans>Some reference records have incompatible units or metric definitions and were excluded.</Trans></p> : null}
                </div>
              ))}
              <p><Trans>These are descriptive agreement results, not clinical accuracy, independent holdout evidence, or authorization to activate a profile.</Trans></p>
              <details>
                <summary><Trans>Comparison evidence</Trans></summary>
                <dl className="break-all text-xs">
                  <dt><Trans>Reference content hash</Trans></dt>
                  <dd>{result.referenceSummary?.contentHash}</dd>
                  <dt><Trans>Comparison report hash</Trans></dt>
                  <dd>{result.reportHash}</dd>
                </dl>
              </details>
            </div>
          )
        : null}
    </section>
  )
}
