'use client'

import { useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { ExperimentBuilder } from './ExperimentBuilder'

interface Cohort { cohortId: string, startMs: number, endMs: number, nightLabels: string[] }
export function WaveformDatasetBuilder({ parentId, parentHash, cohorts }: { parentId: string, parentHash: string, cohorts: Cohort[] }) {
  const { t } = useLingui()
  const [night, setNight] = useState(cohorts[0]?.cohortId ?? '')
  const [cursor, setCursor] = useState<string>()
  const [scanCursor, setScanCursor] = useState<string | null>(null)
  const [scanDone, setScanDone] = useState(false)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [published, setPublished] = useState<string>()
  const [released, setReleased] = useState(false)
  const request = useRef<{ fingerprint: string, key: string } | undefined>(undefined)
  const cohort = cohorts.find(item => item.cohortId === night)
  const admission = trpc.biometricTuning.getReplayAdmission.useQuery({}, { refetchInterval: 10000 })
  const sources = trpc.biometricTuning.listRawSources.useQuery({ startMs: Math.max(0, (cohort?.startMs ?? 300000) - 300000), endMs: cohort?.endMs ?? 1, afterId: cursor }, { enabled: Boolean(cohort) })
  const scan = trpc.biometricTuning.inspectRawSource.useMutation()
  const publish = trpc.biometricTuning.createWaveformDataset.useMutation()
  const utils = trpc.useUtils()
  const busy = scan.isPending || publish.isPending
  const complete = cohorts.length > 0 && cohorts.every(item => (selected[item.cohortId]?.length ?? 0) > 0)
  const input = { parentDatasetId: parentId, expectedContentHash: parentHash,
    cohorts: cohorts.map(item => ({ cohortId: item.cohortId, sourceIds: [...(selected[item.cohortId] ?? [])].sort() })) }
  async function inspect() {
    const result = await scan.mutateAsync({ afterName: scanCursor })
    if (result.status === 'complete') setScanDone(true)
    if (result.status === 'inspected' || result.status === 'source_unavailable') setScanCursor(result.nextCursor)
    await utils.biometricTuning.listRawSources.invalidate()
    void admission.refetch()
  }
  async function retain() {
    if (!complete) return
    setReleased(false)
    const fingerprint = JSON.stringify(input)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('') }
    const result = await publish.mutateAsync({ ...input, idempotencyKey: request.current.key })
    if (result.status === 'published') {
      if (result.dataset.available) setPublished(result.dataset.id)
      else setReleased(true)
      await utils.biometricTuning.listDatasets.invalidate()
    }
    void admission.refetch()
  }
  function toggle(id: string) {
    setSelected((previous) => {
      const ids = previous[night] ?? []
      return { ...previous, [night]: ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 64 ? [...ids, id] : ids }
    })
  }
  const error = admission.error ?? sources.error ?? scan.error ?? publish.error
  return (
    <section className="space-y-3 border-t border-border pt-3" aria-label={t`Retain waveforms`}>
      <p><Trans>Select archives for every frozen night, including five minutes of pre-roll. Archive bounds do not prove continuous signal coverage. The server verifies and copies the selected bytes before publishing a new dataset.</Trans></p>
      {error ? <InlineError>{error.message}</InlineError> : null}
      {!admission.data
        ? <Skeleton className="h-8" />
        : !admission.data.admitted
            ? (
                <p role="status">
                  <Trans>New archive work is currently deferred.</Trans>
                  {' '}
                  {' '}
                  {admission.data.reasons.join(', ')}
                </p>
              )
            : null}
      <fieldset disabled={busy || Boolean(published)} className="space-y-3">
        <Button disabled={!admission.data?.admitted || scanDone} onClick={() => void inspect().catch(() => {})}><Trans>Inspect next archive</Trans></Button>
        <Button onClick={() => {
          setScanCursor(null)
          setScanDone(false)
        }}
        >
          <Trans>Restart archive scan</Trans>
        </Button>
        {scanDone ? <p role="status"><Trans>Archive scan complete.</Trans></p> : null}
        {scan.data?.status === 'source_unavailable' ? <p role="status"><Trans>The last archive was unavailable. Continue to inspect the next archive.</Trans></p> : null}
        {scan.data?.status === 'archive_unavailable' ? <p role="status"><Trans>The archive directory is unavailable.</Trans></p> : null}
        {scan.data?.status === 'deferred' || publish.data?.status === 'deferred' ? <p role="status"><Trans>Work was deferred; your selection and retry key are preserved.</Trans></p> : null}
        <label className="block">
          <Trans>Frozen night</Trans>
          <select
            value={night}
            onChange={(event) => {
              setNight(event.target.value)
              setCursor(undefined)
            }}
          >
            {cohorts.map(item => <option key={item.cohortId} value={item.cohortId}>{item.nightLabels.join(', ')}</option>)}
          </select>
        </label>
        <p>{t`Selected archives for this night: ${(selected[night] ?? []).length} / 64`}</p>
        <Button onClick={() => setSelected(previous => ({ ...previous, [night]: [] }))}><Trans>Clear this night’s selection</Trans></Button>
        {!sources.data && !sources.error ? <Skeleton className="h-20" /> : null}
        {sources.data?.items.length === 0 ? <p><Trans>No inspected archives overlap this night. Inspect archives first.</Trans></p> : null}
        <ul className="space-y-2">
          {sources.data?.items.map(source => (
            <li key={source.id}>
              <label>
                <input
                  type="checkbox"
                  checked={(selected[night] ?? []).includes(source.id)}
                  disabled={!source.inspection.inventory.ordered_waveform_available || ((selected[night] ?? []).length >= 64 && !(selected[night] ?? []).includes(source.id))}
                  onChange={() => toggle(source.id)}
                />
                {' '}
                {source.inspection.source_name}
                {' — '}
                {t`Compressed bytes: ${source.inspection.artifact.compressed_bytes}`}
                {' — '}
                <Trans>Requires re-verification</Trans>
              </label>
              {source.inspection.inventory.first_event_ms != null && source.inspection.inventory.last_event_ms != null
                ? <p className="text-xs">{t`Archive event bounds (UTC): ${new Date(source.inspection.inventory.first_event_ms).toISOString()} to ${new Date(source.inspection.inventory.last_event_ms).toISOString()}`}</p>
                : null}
            </li>
          ))}
        </ul>
        {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>First archive page</Trans></Button> : null}
        {sources.data?.nextCursor ? <Button onClick={() => setCursor(sources.data?.nextCursor ?? undefined)}><Trans>Next archive page</Trans></Button> : null}
        <Button disabled={!complete} onClick={() => void retain().catch(() => {})}><Trans>Retain selected waveforms</Trans></Button>
      </fieldset>
      {released ? <p role="status"><Trans>This request refers to a released dataset. Its waveform bytes are unavailable.</Trans></p> : null}
      {published
        ? (
            <div role="status">
              <p>{t`Waveform dataset retained: ${published}`}</p>
              <ExperimentBuilder datasetId={published} stageReplay={true} waveformReplay />
            </div>
          )
        : null}
    </section>
  )
}
