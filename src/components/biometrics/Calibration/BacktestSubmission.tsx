'use client'

import { useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { BacktestJobDetails } from './BacktestJobs'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, Skeleton } from '@/src/components/ds'

export function BacktestSubmission({ side, experimentId, datasetId }: { side: 'left' | 'right', experimentId: string, datasetId: string }) {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [candidate, setCandidate] = useState<{ id: string, hash: string, generation: number }>()
  const [split, setSplit] = useState<'tuning' | 'validation' | 'holdout'>('tuning')
  const [holdoutAck, setHoldoutAck] = useState<string>()
  const [attempted, setAttempted] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const request = useRef<{ fingerprint: string, key: string } | undefined>(undefined)
  const profiles = trpc.biometricTuning.listProfileRevisions.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id })
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side }, { refetchInterval: 5000 })
  const dataset = trpc.biometricTuning.getDataset.useQuery({ id: datasetId })
  const enqueue = trpc.biometricTuning.enqueueBacktest.useMutation()
  const utils = trpc.useUtils()
  const error = profiles.error ?? overview.error ?? dataset.error
  if (error) return <InlineError>{error.message}</InlineError>
  if (!profiles.data || !overview.data || !dataset.data) return <Skeleton className="h-32" />
  if (!dataset.data.available) return <p><Trans>The retained inputs are unavailable for new evaluations.</Trans></p>
  const generation = overview.data.desired.binding.generation
  const input = candidate ? { experimentId, candidateRevisionId: candidate.id, expectedBindingGeneration: candidate.generation, split } : undefined
  const fingerprint = JSON.stringify(input)
  const availableSplits = new Set(dataset.data.manifest.splitProtocol.assignments.map(cohort => cohort.split))
  const valid = candidate && (candidate.generation === generation || attempted === fingerprint) && availableSplits.has(split) && (split !== 'holdout' || holdoutAck === fingerprint)
  async function submit() {
    if (!input || !valid) return
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('') }
    setAttempted(fingerprint)
    await enqueue.mutateAsync({ ...input, idempotencyKey: request.current.key })
    setSaved(fingerprint)
    void utils.biometricTuning.listBacktests.invalidate({ side })
    void utils.biometricTuning.listExperiments.invalidate({ side })
  }
  return (
    <section className="space-y-3" aria-label={t`Backtest submission`}>
      {dataset.data.manifest.version === 'waveform-dataset-manifest-v1' ? <p><Trans>The server pins default, current baseline, and candidate configurations, plus the other side’s configuration. Replay uses retained signals and never replaces original observations.</Trans></p> : <p><Trans>The server captures default, current stage-view, and candidate configurations at submission. Stored readings cannot validate numerical parameter changes.</Trans></p>}
      <p className="break-all font-mono text-xs">{dataset.data.contentHash}</p>
      <fieldset disabled={enqueue.isPending} className="space-y-3">
        {profiles.data.items.length === 0 ? <p><Trans>No saved candidate revisions.</Trans></p> : null}
        <ul>
          {profiles.data.items.map(profile => (
            <li key={profile.id}>
              <label>
                <input type="radio" name={`candidate-${experimentId}`} checked={candidate?.id === profile.id} onChange={() => setCandidate({ id: profile.id, hash: profile.resolvedHash, generation })} />
                {' '}
                {t`Candidate revision ${profile.revision}: ${profile.id}`}
              </label>
            </li>
          ))}
        </ul>
        {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest profiles</Trans></Button> : null}
        {profiles.data.nextCursor ? <Button onClick={() => setCursor(profiles.data?.nextCursor ?? undefined)}><Trans>Older profiles</Trans></Button> : null}
        {candidate
          ? (
              <p className="break-all font-mono text-xs">
                {candidate.id}
                {' — '}
                {candidate.hash}
              </p>
            )
          : null}
        {candidate && candidate.generation !== generation ? <Button onClick={() => setCandidate({ ...candidate, generation })}><Trans>Prepare a new request with the current baseline</Trans></Button> : null}
        <label className="block">
          <Trans>Evaluation split</Trans>
          <select className="ml-2 rounded border p-2" value={split} onChange={event => setSplit(event.target.value as typeof split)}>
            <option value="tuning" disabled={!availableSplits.has('tuning')}>{t`Tuning`}</option>
            <option value="validation" disabled={!availableSplits.has('validation')}>{t`Validation`}</option>
            <option value="holdout" disabled={!availableSplits.has('holdout')}>{t`Holdout`}</option>
          </select>
        </label>
        {split === 'holdout'
          ? (
              <label className="block">
                <input type="checkbox" checked={holdoutAck === fingerprint} onChange={event => setHoldoutAck(event.target.checked ? fingerprint : undefined)} />
                {' '}
                <Trans>I intend to expose this holdout. Repeated use, including overlapping datasets, weakens held-out evidence.</Trans>
              </label>
            )
          : null}
        <Button disabled={!valid || saved === fingerprint} onClick={() => void submit().catch(() => {})}><Trans>Queue backtest</Trans></Button>
      </fieldset>
      {enqueue.error ? <InlineError>{enqueue.error.message}</InlineError> : null}
      {enqueue.data
        ? (
            <div role="status">
              <p>{t`Backtest request saved: ${enqueue.data.id}`}</p>
              <p><Trans>A saved request does not mean execution has started or succeeded. Inspect the job for its current state.</Trans></p>
              <p className="break-all font-mono text-xs">{enqueue.data.evaluatorBuildHash}</p>
              <BacktestJobDetails key={enqueue.data.id} id={enqueue.data.id} />
            </div>
          )
        : null}
    </section>
  )
}
