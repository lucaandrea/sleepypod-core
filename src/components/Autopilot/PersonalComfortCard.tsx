'use client'

import { useState, type FormEvent } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button, SegmentedControl } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import type { Side } from '@/src/hardware/types'
import type { ComfortStatus } from '@/src/comfort/contract'
import type { ComfortConfig, ComfortFeedback } from '@/src/comfort/policy'
import { Card } from './primitives'

const fieldClass = 'rounded-ctl border border-line bg-surface px-3 py-2 text-sm text-fg'

export function PersonalComfortCard() {
  const [side, setSide] = useState<Side>('left')
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const query = trpc.comfort.get.useQuery({ side }, { refetchInterval: 5_000 })
  const refresh = () => {
    void utils.comfort.get.invalidate()
  }
  const configuration = trpc.comfort.configure.useMutation({ onSuccess: refresh })
  const feedback = trpc.comfort.feedback.useMutation({ onSuccess: refresh })
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Personal comfort</h2>
          <p className="mt-1 text-sm text-fg-2">Learn from your check-ins. Review proposed changes before activation.</p>
        </div>
        <SegmentedControl
          ariaLabel="Personal comfort side"
          value={side}
          onChange={(value) => {
            configuration.reset()
            feedback.reset()
            setSide(value)
          }}
          options={(['left', 'right'] as const).map(value => ({ value, label: sideName(value) }))}
        />
      </div>
      {query.isLoading && <p className="mt-4 text-sm text-fg-2" role="status">Reading personal comfort settings…</p>}
      {query.error && <p className="mt-4 text-sm text-danger" role="alert">Could not refresh personal comfort. Displayed observations may be old.</p>}
      {query.data && (
        <PersonalComfortDetails
          key={`${side}:${JSON.stringify(query.data.state?.config)}`}
          data={query.data}
          pending={configuration.isPending || feedback.isPending || Boolean(query.error)}
          onConfigure={config => configuration.mutate({ side, config })}
          onFeedback={report => feedback.mutate({ side, feedback: report })}
        />
      )}
      {(configuration.error || feedback.error) && <p className="mt-4 text-sm text-danger" role="alert">{configuration.error?.message ?? feedback.error?.message}</p>}
      {feedback.isSuccess && <p className="mt-3 text-sm text-fg-2" role="status">Check-in saved.</p>}
    </Card>
  )
}

export function PersonalComfortDetails({ data, pending, onConfigure, onFeedback }: {
  data: ComfortStatus
  pending: boolean
  onConfigure(config: ComfortConfig): void
  onFeedback(feedback: ComfortFeedback): void
}) {
  const state = data.state
  const clock = (at: number) => new Date(at).toLocaleString(undefined, { timeZone: data.timezone ?? 'UTC', dateStyle: 'medium', timeStyle: 'short' })
  const saveRange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!state) return
    const fields = new FormData(event.currentTarget)
    onConfigure({ ...state.config, mode: state.config.mode === 'preview' ? 'preview' : 'off', minimumF: Number(fields.get('minimum')), maximumF: Number(fields.get('maximum')) })
  }
  const saveFeedback = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    onFeedback({ date: String(fields.get('date')), comfort: String(fields.get('comfort')) as ComfortFeedback['comfort'] })
  }
  return (
    <div className="mt-5 space-y-5">
      <div className="rounded-ctl border border-line bg-active p-4 text-sm">
        <p className="font-medium">{state?.config.mode === 'preview' ? 'Preview only' : state?.config.mode === 'active' ? 'Activation locked' : 'Personal comfort off'}</p>
        <p className="mt-1 text-fg-2">Preview does not adjust the bed. Your existing routines and rules continue.</p>
        <p className="mt-2">{data.fault ?? data.decision?.reason ?? (data.evaluatedAt === null ? 'No evaluation recorded yet.' : 'Waiting for a current evaluation.')}</p>
        {data.evaluatedAt !== null && (
          <p className="mt-2 text-xs text-fg-2">
            Last evaluation:
            {' '}
            <time dateTime={new Date(data.evaluatedAt).toISOString()}>{clock(data.evaluatedAt)}</time>
          </p>
        )}
        {data.runtime === 'stopped' && <p className="mt-2 text-fg-2">The Preview service is stopped.</p>}
      </div>
      {state && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={pending || (Boolean(data.fault) && state.config.mode !== 'preview')} variant="primary" onClick={() => onConfigure({ ...state.config, mode: state.config.mode === 'preview' ? 'off' : 'preview', sensorAware: false, followBedtime: false })}>
              {state.config.mode === 'preview' ? 'Stop Preview' : 'Start Preview'}
            </Button>
            <span className="text-sm text-fg-2">
              {`Learned offset ${state.offsetF > 0 ? '+' : ''}${state.offsetF}°F · maximum change 1°F`}
            </span>
          </div>
          {state.pausedUntil > data.generatedAt && (
            <p className="text-sm text-fg-2">
              {`Manual pause until ${clock(state.pausedUntil)}.`}
            </p>
          )}
          {data.decision?.eligible && data.decision.proposedF !== null && (
            <p className="text-sm">
              Proposed target:
              {' '}
              <strong>
                {data.decision.proposedF}
                °F
              </strong>
              . This is a proposal, not a hardware action.
            </p>
          )}
          <form onSubmit={saveRange} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-fg-2">
              Minimum °F
              <input className={`${fieldClass} w-24`} name="minimum" type="number" min="55" max="110" step="1" required defaultValue={state.config.minimumF} />
            </label>
            <label className="grid gap-1 text-xs text-fg-2">
              Maximum °F
              <input className={`${fieldClass} w-24`} name="maximum" type="number" min="55" max="110" step="1" required defaultValue={state.config.maximumF} />
            </label>
            <Button type="submit" disabled={pending || Boolean(data.fault)}>Save range</Button>
          </form>
        </>
      )}
      <form onSubmit={saveFeedback} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <label className="grid gap-1 text-xs text-fg-2">
          Sleep date (
          {data.timezone ?? 'unavailable'}
          )
          <input key={data.deviceDate} className={fieldClass} name="date" type="date" required defaultValue={data.deviceDate ?? ''} max={data.deviceDate ?? undefined} />
        </label>
        <label className="grid gap-1 text-xs text-fg-2">
          How did the bed feel?
          <select className={fieldClass} name="comfort" defaultValue="comfortable">
            <option value="comfortable">Comfortable</option>
            <option value="warm">Too warm</option>
            <option value="cold">Too cold</option>
          </select>
        </label>
        <Button type="submit" disabled={pending || Boolean(data.fault) || !data.deviceDate}>Save check-in</Button>
      </form>
      <p className="text-xs text-fg-2">
        {data.activation.reason}
        {' '}
        Sensor-aware adjustments and bedtime phase changes are not available yet.
      </p>
      <details className="border-t border-line pt-3 text-sm">
        <summary className="cursor-pointer text-fg-2">Recent observations</summary>
        {data.history.length === 0
          ? <p className="mt-3 text-fg-2">No observations recorded.</p>
          : (
              <ol className="mt-3 space-y-3">
                {data.history.slice(0, 10).map((entry, index) => (
                  <li key={`${entry.at}:${index}`}>
                    <time className="text-xs text-fg-2" dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
                    <p>{entry.message}</p>
                    {entry.kind === 'preview' && (
                      <p className="text-xs text-fg-2">
                        Reported target:
                        {entry.reportedF === null ? 'unavailable' : `${entry.reportedF}°F`}
                        {' '}
                        · Owner:
                        {entry.owner ?? 'unavailable'}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
      </details>
    </div>
  )
}
