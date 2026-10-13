'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError } from '@/src/components/ds'
import { ActivationReceipt } from './ManualProfileActivation'

export interface ValidatedSelection { side: 'left' | 'right', revisionId: string, expectedResolvedHash: string, evaluationId: string, expectedReportHash: string }
export function ValidatedProfileActivation({ selection }: { selection: ValidatedSelection }) {
  const { t } = useLingui()
  const [boundary, setBoundary] = useState<'immediate' | 'next_session'>('next_session')
  const [intent, setIntent] = useState<ValidatedSelection & { expectedGeneration: number, boundary: typeof boundary, requester: string, idempotencyKey: string }>()
  const [eventId, setEventId] = useState<string>()
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side: selection.side })
  const reviewInput = { ...selection, expectedGeneration: overview.data?.desired.binding.generation ?? 0 }
  const review = trpc.biometricTuning.reviewValidatedActivation.useQuery(reviewInput, { enabled: Boolean(overview.data) && !intent, retry: false })
  const activation = trpc.biometricTuning.activateValidatedProfile.useMutation()
  const utils = trpc.useUtils()
  async function apply() {
    if (!intent && (!review.data?.eligible || !overview.data)) return
    const request = intent ?? { ...reviewInput, boundary, requester: 'web-calibration', idempotencyKey: crypto.randomUUID() }
    setIntent(request)
    const event = await activation.mutateAsync(request)
    setEventId(event.id)
    void utils.biometricTuning.getProfileOverview.invalidate({ side: request.side })
    void utils.biometricTuning.listActivationHistory.invalidate({ side: request.side })
  }
  if (eventId) return <ActivationReceipt side={intent?.side ?? selection.side} id={eventId} />
  return (
    <section aria-label={t`Validated activation`} className="space-y-3 border-t border-border pt-3">
      <p><Trans>Apply this exact candidate using the selected evaluation. Evidence and current settings are checked again when applying.</Trans></p>
      <p><Trans>Agreement with a named reference does not establish clinical accuracy.</Trans></p>
      <label>
        <Trans>Activation timing</Trans>
        <select value={boundary} disabled={activation.isPending || Boolean(intent)} onChange={event => setBoundary(event.target.value as typeof boundary)}>
          <option value="next_session">{t`Next session boundary`}</option>
          <option value="immediate">{t`Immediate processing boundary`}</option>
        </select>
      </label>
      {!intent && !review.data && !review.error && !overview.error ? <p role="status"><Trans>Checking validation evidence…</Trans></p> : null}
      {overview.error ? <InlineError>{overview.error.message}</InlineError> : null}
      {review.error && !intent ? <InlineError>{review.error.message}</InlineError> : null}
      {activation.error ? <InlineError>{activation.error.message}</InlineError> : null}
      <Button disabled={activation.isPending || (!intent && (!overview.data || !review.data?.eligible || Boolean(review.error) || review.isFetching))} onClick={() => void apply().catch(() => {})}>
        {intent ? <Trans>Retry exact activation request</Trans> : <Trans>Apply evaluated revision</Trans>}
      </Button>
    </section>
  )
}
