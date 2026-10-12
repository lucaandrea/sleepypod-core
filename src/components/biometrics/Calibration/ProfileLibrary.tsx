'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'
import { ProfileComparison } from './ProfileComparison'
import { ProfileCandidateEditor } from './ProfileCandidateEditor'

export function ProfileLibrary({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [comparedId, setComparedId] = useState<string>()
  const [revisionId, setRevisionId] = useState<string>()
  const profiles = trpc.biometricTuning.listProfileRevisions.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id })
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <CardHeader title={<Trans>Saved profile revisions</Trans>} subtitle={<Trans>A saved revision is not evidence of validation or processor adoption.</Trans>} />
        {revisionId ? <p role="status">{t`Editing from revision ${revisionId}`}</p> : <p><Trans>Editing from the currently saved profile.</Trans></p>}
        {revisionId ? <Button onClick={() => setRevisionId(undefined)}><Trans>Start from current profile</Trans></Button> : null}
        {profiles.error
          ? <InlineError>{profiles.error.message}</InlineError>
          : !profiles.data
              ? <Skeleton className="h-32" />
              : (
                  <>
                    {profiles.data.items.length === 0 ? <p><Trans>No saved candidate revisions.</Trans></p> : null}
                    <ul className="space-y-3">
                      {profiles.data.items.map(profile => (
                        <li key={profile.id} className="space-y-2 border-b border-border pb-3">
                          <p>{t`Revision ${profile.revision} · ${profile.origin} · ${profile.requester}`}</p>
                          <p className="break-all font-mono text-xs">{profile.id}</p>
                          <Button onClick={() => setRevisionId(profile.id)} aria-pressed={revisionId === profile.id}><Trans>Edit a new candidate from this revision</Trans></Button>
                          <Button onClick={() => setComparedId(comparedId === profile.id ? undefined : profile.id)} aria-expanded={comparedId === profile.id}><Trans>Inspect candidate changes</Trans></Button>
                          {comparedId === profile.id ? <ProfileComparison key={profile.id} side={side} revisionId={profile.id} /> : null}
                          <details>
                            <summary><Trans>Pinned configuration and overrides</Trans></summary>
                            <dl className="break-all text-xs">
                              <dt><Trans>Resolved configuration hash</Trans></dt>
                              <dd>{profile.resolvedHash}</dd>
                              <dt><Trans>Engine manifest hash</Trans></dt>
                              <dd>{profile.baseManifestHash}</dd>
                              <dt><Trans>Parent revision</Trans></dt>
                              <dd>{profile.parentRevisionId ?? '—'}</dd>
                            </dl>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(profile.overrides, null, 2)}</pre>
                          </details>
                        </li>
                      ))}
                    </ul>
                    <div className="flex gap-2">
                      {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest profiles</Trans></Button> : null}
                      {profiles.data.nextCursor ? <Button onClick={() => setCursor(profiles.data?.nextCursor ?? undefined)}><Trans>Older profiles</Trans></Button> : null}
                    </div>
                  </>
                )}
      </Card>
      <ProfileCandidateEditor side={side} revisionId={revisionId} />
    </div>
  )
}
