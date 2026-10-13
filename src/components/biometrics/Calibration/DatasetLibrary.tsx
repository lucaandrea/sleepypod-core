'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { WaveformDatasetBuilder } from './WaveformDatasetBuilder'
import { ExperimentBuilder } from './ExperimentBuilder'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'

export function DatasetLibrary({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [selected, setSelected] = useState<string>()
  const datasets = trpc.biometricTuning.listDatasets.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id })
  return (
    <Card className="space-y-3">
      <CardHeader title={<Trans>Retained datasets</Trans>} subtitle={<Trans>Inspect frozen inputs and whole-night partitions, or release their retained storage.</Trans>} />
      {datasets.error
        ? <InlineError>{datasets.error.message}</InlineError>
        : !datasets.data
            ? <Skeleton className="h-32" />
            : (
                <>
                  {datasets.data.items.length === 0 ? <p><Trans>No retained datasets for this side.</Trans></p> : null}
                  <ul className="space-y-3">
                    {datasets.data.items.map(dataset => (
                      <li key={dataset.id} className="space-y-2 border-b border-border pb-3">
                        <p>
                          {dataset.subjectId}
                          {' — '}
                          {dataset.available ? <Trans>Inputs retained</Trans> : <Trans>Inputs released; metadata retained</Trans>}
                        </p>
                        <p className="break-all font-mono text-xs">{dataset.id}</p>
                        <p>{t`Retained bytes: ${dataset.byteLength}`}</p>
                        <Button aria-expanded={selected === dataset.id} onClick={() => setSelected(selected === dataset.id ? undefined : dataset.id)}><Trans>Inspect dataset</Trans></Button>
                        {selected === dataset.id ? <DatasetDetails key={dataset.id} id={dataset.id} /> : null}
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest datasets</Trans></Button> : null}
                    {datasets.data.nextCursor ? <Button onClick={() => setCursor(datasets.data?.nextCursor ?? undefined)}><Trans>Older datasets</Trans></Button> : null}
                  </div>
                </>
              )}
    </Card>
  )
}
function DatasetDetails({ id }: { id: string }) {
  const { t } = useLingui()
  const [waveforms, setWaveforms] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const dataset = trpc.biometricTuning.getDataset.useQuery({ id })
  const release = trpc.biometricTuning.releaseDataset.useMutation()
  const utils = trpc.useUtils()
  async function releaseInputs() {
    await release.mutateAsync({ id })
    setConfirmRelease(false)
    await Promise.all([utils.biometricTuning.listDatasets.invalidate(), utils.biometricTuning.getDataset.invalidate({ id })])
  }
  if (dataset.error) return <InlineError>{dataset.error.message}</InlineError>
  if (!dataset.data) return <Skeleton className="h-32" />
  const data = dataset.data
  const splits = { tuning: t`Tuning`, validation: t`Validation`, holdout: t`Holdout` }
  return (
    <section className="space-y-3" aria-label={t`Frozen input details`}>
      <p className="break-all font-mono text-xs">{data.contentHash}</p>
      <p>{data.available ? <Trans>Retained input integrity checked by the server.</Trans> : <Trans>The retained inputs are unavailable for new evaluations.</Trans>}</p>
      <p>{t`Partition timezone: ${data.manifest.splitProtocol.timezone}`}</p>
      <p>{data.manifest.splitProtocol.evidence === 'descriptive_only' ? <Trans>Descriptive evaluation only</Trans> : <Trans>Whole-night partitions assigned; biometric performance is not yet validated.</Trans>}</p>
      <ul>
        {data.manifest.splitProtocol.assignments.map(cohort => (
          <li key={cohort.cohortId}>
            {cohort.nightLabels.join(', ')}
            {' — '}
            {splits[cohort.split]}
            {' — '}
            {t`Sessions: ${cohort.sessionIds.join(', ')}`}
          </li>
        ))}
      </ul>
      {data.manifest.splitProtocol.limitations.map(limitation => <p key={limitation}>{limitation}</p>)}
      {data.manifest.limitations.map(limitation => <p key={limitation}>{limitation}</p>)}
      <details>
        <summary><Trans>Frozen coverage and capabilities</Trans></summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ coverage: data.manifest.coverage, capabilities: data.manifest.capabilities }, null, 2)}</pre>
      </details>
      {data.available ? <ExperimentBuilder datasetId={id} stageReplay={data.manifest.capabilities.stageReplay} waveformReplay={data.manifest.version === 'waveform-dataset-manifest-v1'} /> : null}
      {data.available && data.manifest.version === 'processed-dataset-manifest-v1' ? <Button aria-expanded={waveforms} onClick={() => setWaveforms(!waveforms)}><Trans>Select recorded waveforms</Trans></Button> : null}
      {data.available && waveforms ? <WaveformDatasetBuilder key={data.contentHash} parentId={data.id} parentHash={data.contentHash} cohorts={data.manifest.splitProtocol.assignments} /> : null}
      {data.available
        ? (
            confirmRelease
              ? (
                  <div className="space-y-2">
                    <p><Trans>Release these retained inputs permanently? Existing reports and audit metadata remain. Active jobs must finish or be cancelled first.</Trans></p>
                    <Button disabled={release.isPending} onClick={() => void releaseInputs().catch(() => {})}><Trans>Permanently release inputs</Trans></Button>
                    <Button disabled={release.isPending} onClick={() => setConfirmRelease(false)}><Trans>Keep retained inputs</Trans></Button>
                  </div>
                )
              : <Button onClick={() => setConfirmRelease(true)}><Trans>Release retained inputs</Trans></Button>
          )
        : null}
      {release.error ? <InlineError>{release.error.message}</InlineError> : null}
    </section>
  )
}
