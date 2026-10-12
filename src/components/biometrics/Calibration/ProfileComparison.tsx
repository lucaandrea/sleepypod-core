'use client'

import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'

export function ProfileComparison({ side, revisionId }: { side: 'left' | 'right', revisionId: string }) {
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side }, { refetchInterval: 5000 })
  const diff = trpc.biometricTuning.diffProfileRevision.useMutation()
  const [reviewedGeneration, setReviewedGeneration] = useState<number>()
  const current = overview.data?.desired
  async function compare() {
    if (!current) return
    setReviewedGeneration(undefined)
    const generation = current.binding.generation
    await diff.mutateAsync({ side, revisionId, againstRevisionId: current.binding.desiredRevisionId })
    setReviewedGeneration(generation)
  }
  if (overview.error) return <InlineError>{overview.error.message}</InlineError>
  if (!current) return <Skeleton className="h-32" />
  const reviewed = diff.data && reviewedGeneration !== undefined
  const stale = reviewed && (reviewedGeneration !== current.binding.generation || diff.data.beforeHash !== current.hash || diff.data.revisionId !== revisionId)
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Candidate changes</Trans>} subtitle={<Trans>Compare against the saved profile. This is a configuration comparison, not validation evidence.</Trans>} />
      <p className="break-all font-mono text-xs">{revisionId}</p>
      {current.warning ? <InlineError>{current.warning}</InlineError> : null}
      <Button disabled={diff.isPending || Boolean(current.warning)} onClick={() => void compare().catch(() => {})}><Trans>Compare with saved profile</Trans></Button>
      {diff.error ? <InlineError>{diff.error.message}</InlineError> : null}
      {stale ? <p role="status"><Trans>The saved profile changed. Compare again before reviewing these changes.</Trans></p> : null}
      {reviewed && !stale
        ? (
            <>
              <dl className="break-all text-xs">
                <dt><Trans>Before configuration hash</Trans></dt>
                <dd>{diff.data.beforeHash}</dd>
                <dt><Trans>After configuration hash</Trans></dt>
                <dd>{diff.data.afterHash}</dd>
              </dl>
              {diff.data.changes.length === 0
                ? <p><Trans>No resolved value changes.</Trans></p>
                : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <caption className="text-left"><Trans>Resolved parameter changes</Trans></caption>
                        <thead>
                          <tr>
                            <th scope="col"><Trans>Parameter</Trans></th>
                            <th scope="col"><Trans>Before</Trans></th>
                            <th scope="col"><Trans>After</Trans></th>
                          </tr>
                        </thead>
                        <tbody>
                          {diff.data.changes.map(change => (
                            <tr key={change.path}>
                              <th scope="row">{change.path}</th>
                              <td><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(change.before, null, 2)}</pre></td>
                              <td><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(change.after, null, 2)}</pre></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              <p><Trans>Override intent can change even when the resolved value stays the same.</Trans></p>
              {diff.data.intentChangedPaths.length === 0 ? <p><Trans>No override intent changes.</Trans></p> : <ul>{diff.data.intentChangedPaths.map(path => <li key={path} className="break-all font-mono text-xs">{path}</li>)}</ul>}
            </>
          )
        : null}
    </Card>
  )
}
