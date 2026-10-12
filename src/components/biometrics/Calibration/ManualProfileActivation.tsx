'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, Skeleton } from '@/src/components/ds'

interface Intent { side: 'left' | 'right', revisionId: string, expectedGeneration: number, expectedResolvedHash: string, boundary: 'immediate' | 'next_session', requester: string, idempotencyKey: string, allowUnvalidated: true }
export function ManualProfileActivation({ side, revisionId, review }: { side: 'left' | 'right', revisionId: string, review?: { generation: number, hash: string } }) {
  const { t } = useLingui()
  const [acknowledgedReview, setAcknowledgedReview] = useState<string>()
  const [boundary, setBoundary] = useState<'immediate' | 'next_session'>('next_session')
  const [intent, setIntent] = useState<Intent>()
  const reviewKey = review ? `${revisionId}:${review.generation}:${review.hash}` : undefined
  const acknowledged = Boolean(acknowledgedReview && (intent || acknowledgedReview === reviewKey))
  const [eventId, setEventId] = useState<string>()
  const activation = trpc.biometricTuning.activateProfile.useMutation()
  const utils = trpc.useUtils()
  async function apply() {
    if (!acknowledged || (!review && !intent)) return
    const request: Intent | undefined = intent ?? (review
      ? { side, revisionId, expectedGeneration: review.generation, expectedResolvedHash: review.hash, boundary,
          requester: 'web-calibration', idempotencyKey: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join(''), allowUnvalidated: true }
      : undefined)
    if (!request) return
    setIntent(request)
    const event = await activation.mutateAsync(request)
    setEventId(event.id)
    void utils.biometricTuning.getProfileOverview.invalidate({ side })
    void utils.biometricTuning.listActivationHistory.invalidate({ side })
  }
  return (
    <section aria-label={t`Manual activation`} className="space-y-3 border-t border-border pt-3">
      <p><Trans>Manual application is unvalidated. It can change heart rate, breathing rate, the HRV index, and dependent sleep stages.</Trans></p>
      {!eventId
        ? (
            <>
              <label className="block">
                <Trans>Activation timing</Trans>
                <select disabled={activation.isPending || Boolean(intent)} className="ml-2 rounded border p-2" value={boundary} onChange={event => setBoundary(event.target.value as typeof boundary)}>
                  <option value="next_session">{t`Next session boundary`}</option>
                  <option value="immediate">{t`Immediate processing boundary`}</option>
                </select>
              </label>
              <p className="text-sm text-fg-2"><Trans>Next session waits for a known empty-bed boundary. Immediate application still waits for a safe processing boundary.</Trans></p>
              <label className="block">
                <input type="checkbox" checked={acknowledged} disabled={activation.isPending || Boolean(intent)} onChange={event => setAcknowledgedReview(event.target.checked ? reviewKey : undefined)} />
                {' '}
                <Trans>I intend to apply this exact revision without validation evidence.</Trans>
              </label>
              <Button disabled={activation.isPending || !acknowledged || (!review && !intent)} onClick={() => void apply().catch(() => {})}>{intent ? <Trans>Retry exact activation request</Trans> : <Trans>Apply unvalidated revision</Trans>}</Button>
            </>
          )
        : <ActivationReceipt side={side} id={eventId} />}
      {activation.error ? <InlineError>{activation.error.message}</InlineError> : null}
    </section>
  )
}
function ActivationReceipt({ side, id }: { side: 'left' | 'right', id: string }) {
  const { t } = useLingui()
  const status = trpc.biometricTuning.getActivationStatus.useQuery({ side, id }, { refetchInterval: 5000 })
  const labels: Record<string, string> = { unreported: t`Not reported`, pending_delivery: t`Waiting for delivery`, pending_boundary: t`Waiting for a processing boundary`, applied: t`Applied`, failed: t`Failed` }
  return (
    <div role="status" className="space-y-2">
      <p><Trans>Activation request saved. Processor acknowledgement is reported separately below.</Trans></p>
      <p className="break-all font-mono text-xs">{id}</p>
      {status.error
        ? <InlineError>{status.error.message}</InlineError>
        : !status.data
            ? <Skeleton className="h-12" />
            : (
                <>
                  <p>{labels[status.data.observedState]}</p>
                  {!status.data.isCurrent ? <p><Trans>This request has been superseded by another profile change.</Trans></p> : null}
                  <p><Trans>Check Overview for current processor health; a past acknowledgement does not prove current health.</Trans></p>
                </>
              )}
    </div>
  )
}
