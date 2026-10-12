'use client'

import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds'
import { ProfileComparison } from './ProfileComparison'

export function ProfileRecovery({ side }: { side: 'left' | 'right' }) {
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side }, { refetchInterval: 5000 })
  const [selection, setSelection] = useState<{ action: 'reset' | 'rollback', revisionId: string | null, generation: number }>()
  const binding = overview.data?.desired.binding
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Restore a profile</Trans>} subtitle={<Trans>Review changes before requesting system defaults or the exact previous profile.</Trans>} />
      {overview.error ? <InlineError>{overview.error.message}</InlineError> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!binding} onClick={() => binding && setSelection({ action: 'reset', revisionId: null, generation: binding.generation })}><Trans>Review system defaults</Trans></Button>
        <Button disabled={!binding || binding.generation === 0} onClick={() => binding && setSelection({ action: 'rollback', revisionId: binding.previousRevisionId, generation: binding.generation })}><Trans>Review previous profile</Trans></Button>
      </div>
      {selection ? <ProfileComparison key={`${selection.action}:${selection.generation}:${selection.revisionId}`} side={side} action={selection.action} revisionId={selection.revisionId} selectionGeneration={selection.generation} /> : null}
    </Card>
  )
}
