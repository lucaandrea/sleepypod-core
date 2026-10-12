'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'
import { BacktestSubmission } from './BacktestSubmission'

export function ExperimentLibrary({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [selected, setSelected] = useState<string>()
  const experiments = trpc.biometricTuning.listExperiments.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id })
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Saved experiments</Trans>} />
      {experiments.error
        ? <InlineError>{experiments.error.message}</InlineError>
        : !experiments.data
            ? <Skeleton className="h-32" />
            : (
                <>
                  {experiments.data.items.length === 0 ? <p><Trans>No saved experiments for this side.</Trans></p> : null}
                  <ul className="space-y-3">
                    {experiments.data.items.map(experiment => (
                      <li key={experiment.id} className="space-y-2 border-b border-border pb-3">
                        <p className="break-all font-mono text-xs">{experiment.id}</p>
                        <p>{experiment.protocol.mode === 'stage_replay' ? <Trans>Replay sleep stages</Trans> : <Trans>Compare stored readings</Trans>}</p>
                        <p>{t`Holdout accesses recorded for this experiment: ${experiment.holdoutAccesses}`}</p>
                        <details>
                          <summary><Trans>Pinned evaluation protocol</Trans></summary>
                          <p className="break-all font-mono text-xs">{experiment.protocolHash}</p>
                          <pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(experiment.protocol, null, 2)}</pre>
                        </details>
                        <Button aria-expanded={selected === experiment.id} onClick={() => setSelected(selected === experiment.id ? undefined : experiment.id)}><Trans>Prepare backtest</Trans></Button>
                        {selected === experiment.id ? <BacktestSubmission key={experiment.id} side={side} experimentId={experiment.id} datasetId={experiment.datasetId} /> : null}
                      </li>
                    ))}
                  </ul>
                  {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest experiments</Trans></Button> : null}
                  {experiments.data.nextCursor ? <Button onClick={() => setCursor(experiments.data?.nextCursor ?? undefined)}><Trans>Older experiments</Trans></Button> : null}
                </>
              )}
    </Card>
  )
}
