'use client'

import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds'
import { ManualProfileActivation } from './ManualProfileActivation'
import { ProfileComparison } from './ProfileComparison'

export function ProfileRecovery({ side }: { side: 'left' | 'right' }) {
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side }, { refetchInterval: 5000 })
  const [selection, setSelection] = useState<{ action: 'reset' | 'rollback', revisionId: string | null, generation: number, fallback?: { hash: string, warning: string, revisionId: string | null } }>()
  const desired = overview.data?.desired
  const binding = desired?.binding
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Restore a profile</Trans>} subtitle={<Trans>Review changes before requesting system defaults or the exact previous profile.</Trans>} />
      {overview.error ? <InlineError>{overview.error.message}</InlineError> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!binding} onClick={() => binding && setSelection({ action: 'reset', revisionId: null, generation: binding.generation, fallback: desired?.warning ? { hash: desired.hash, warning: desired.warning, revisionId: binding.desiredRevisionId } : undefined })}><Trans>Review system defaults</Trans></Button>
        <Button disabled={!binding || binding.generation === 0} onClick={() => binding && setSelection({ action: 'rollback', revisionId: binding.previousRevisionId, generation: binding.generation })}><Trans>Review previous profile</Trans></Button>
      </div>
      {selection?.fallback
        ? (
            <section key={`fallback:${selection.generation}`} className="space-y-3">
              <InlineError>{selection.fallback.warning}</InlineError>
              <p><Trans>The pinned profile is incompatible. Its revision will be preserved, but a valid before-and-after comparison is unavailable.</Trans></p>
              <dl className="break-all text-xs">
                <dt><Trans>Preserved incompatible revision</Trans></dt>
                <dd>{selection.fallback.revisionId ?? '—'}</dd>
                <dt><Trans>Default recovery configuration hash</Trans></dt>
                <dd>{selection.fallback.hash}</dd>
              </dl>
              {selection.generation !== binding?.generation ? <p role="status"><Trans>The saved profile changed. Select a recovery action again to make a new request.</Trans></p> : null}
              <ManualProfileActivation side={side} action="reset" revisionId={null} review={selection.generation === binding?.generation && selection.fallback.hash === desired?.hash ? { generation: selection.generation, hash: selection.fallback.hash } : undefined} />
            </section>
          )
        : selection ? <ProfileComparison key={`${selection.action}:${selection.generation}:${selection.revisionId}`} side={side} action={selection.action} revisionId={selection.revisionId} selectionGeneration={selection.generation} /> : null}
    </Card>
  )
}
