'use client'

import { useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { experimentProtocolSchema } from '@/src/biometrics/backtest/contracts'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError } from '@/src/components/ds'

export function ExperimentBuilder({ datasetId, stageReplay, waveformReplay = false }: { datasetId: string, stageReplay: boolean, waveformReplay?: boolean }) {
  const { t } = useLingui()
  const [mode, setMode] = useState<'comparison' | 'stage_replay' | 'signal_replay'>(waveformReplay ? 'signal_replay' : 'comparison')
  const [waveformStages, setWaveformStages] = useState(false)
  const stages = mode === 'stage_replay' || (mode === 'signal_replay' && waveformStages)
  const supportsUncertainty = stages || mode === 'signal_replay'
  const [quality, setQuality] = useState('')
  const [tolerance, setTolerance] = useState('30000')
  const [offset, setOffset] = useState('0')
  const [uncertainty, setUncertainty] = useState(false)
  const [seed, setSeed] = useState('')
  const [resamples, setResamples] = useState('1000')
  const [minimumNights, setMinimumNights] = useState('3')
  const [saved, setSaved] = useState<string>()
  const request = useRef<{ fingerprint: string, key: string } | undefined>(undefined)
  const create = trpc.biometricTuning.createExperiment.useMutation()
  const utils = trpc.useUtils()
  const numeric = (value: string) => value.trim() === '' ? Number.NaN : Number(value)
  const protocol = experimentProtocolSchema.safeParse({ version: 'descriptive-evaluation-v1', mode,
    assumedStageCalibrationQuality: stages ? numeric(quality) : 0,
    pointToleranceMs: numeric(tolerance), clockOffsetMs: numeric(offset),
    ...(mode === 'signal_replay' ? { waveformStages } : {}),
    ...(uncertainty && supportsUncertainty ? { nightUncertainty: { version: 'paired-night-percentile-v1', seed, resamples: numeric(resamples), minimumNights: numeric(minimumNights) } } : {}),
  })
  const compatible = waveformReplay === (mode === 'signal_replay') && (mode !== 'stage_replay' || stageReplay)
  const fingerprint = protocol.success ? JSON.stringify({ datasetId, protocol: protocol.data }) : undefined
  async function save() {
    if (!protocol.success || !fingerprint || !compatible) return
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('') }
    await create.mutateAsync({ datasetId, protocol: protocol.data, idempotencyKey: request.current.key })
    setSaved(fingerprint)
    void utils.biometricTuning.listExperiments.invalidate()
  }
  return (
    <section className="space-y-3 border-t border-border pt-3" aria-label={t`Evaluation protocol`}>
      <p><Trans>Choose the protocol before looking at results. Creating an experiment does not run a job or apply a profile.</Trans></p>
      <fieldset disabled={create.isPending} className="space-y-3">
        <label className="block">
          <Trans>Evaluation mode</Trans>
          <select className="ml-2 rounded border p-2" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
            <option value="comparison" disabled={waveformReplay}>{t`Compare stored readings`}</option>
            <option value="stage_replay" disabled={!stageReplay || waveformReplay}>{t`Replay sleep stages`}</option>
            {waveformReplay ? <option value="signal_replay">{t`Replay retained waveforms`}</option> : null}
          </select>
        </label>
        {mode === 'signal_replay'
          ? (
              <label className="block">
                <input type="checkbox" checked={waveformStages} onChange={event => setWaveformStages(event.target.checked)} />
                {' '}
                <Trans>Also replay sleep stages</Trans>
              </label>
            )
          : null}
        {stages
          ? (
              <label className="block">
                <Trans>Assumed calibration quality (0–1)</Trans>
                <input type="number" min={0} max={1} step="any" value={quality} onChange={event => setQuality(event.target.value)} />
              </label>
            )
          : null}
        <p><Trans>Stage calibration quality is an explicit replay assumption, not a recovered sensor measurement. Stored-reading comparison does not test numerical parameter changes.</Trans></p>
        <label className="block">
          <Trans>Point matching tolerance (ms, 0–300000)</Trans>
          <input type="number" min={0} max={300000} step={1} value={tolerance} onChange={event => setTolerance(event.target.value)} />
        </label>
        <label className="block">
          <Trans>Fixed offset added to pod timestamps (ms, ±3600000)</Trans>
          <input type="number" min={-3600000} max={3600000} step={1} value={offset} onChange={event => setOffset(event.target.value)} />
        </label>
        <label className="block">
          <input type="checkbox" disabled={!supportsUncertainty} checked={uncertainty && supportsUncertainty} onChange={event => setUncertainty(event.target.checked)} />
          {' '}
          <Trans>Estimate exploratory whole-night uncertainty</Trans>
        </label>
        {uncertainty && supportsUncertainty
          ? (
              <div className="space-y-2">
                <label className="block">
                  <Trans>Reproducible sampling seed</Trans>
                  <input maxLength={64} value={seed} onChange={event => setSeed(event.target.value)} />
                </label>
                <label className="block">
                  <Trans>Resamples (200–5000)</Trans>
                  <input type="number" min={200} max={5000} value={resamples} onChange={event => setResamples(event.target.value)} />
                </label>
                <label className="block">
                  <Trans>Minimum paired nights (3–60)</Trans>
                  <input type="number" min={3} max={60} value={minimumNights} onChange={event => setMinimumNights(event.target.value)} />
                </label>
                <p><Trans>This reporting threshold is not a validated sample-size requirement. Too few or degenerate nights yield no interval.</Trans></p>
              </div>
            )
          : null}
        {!protocol.success ? <p role="status"><Trans>Complete the required fields within their stated bounds.</Trans></p> : null}
        <Button disabled={!protocol.success || saved === fingerprint || !compatible} onClick={() => void save().catch(() => {})}><Trans>Save evaluation protocol</Trans></Button>
      </fieldset>
      {create.error ? <InlineError>{create.error.message}</InlineError> : null}
      {create.data
        ? (
            <div role="status">
              <p>{t`Experiment saved: ${create.data.id}`}</p>
              <p className="break-all font-mono text-xs">{create.data.protocolHash}</p>
            </div>
          )
        : null}
    </section>
  )
}
