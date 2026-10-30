import { useState, useSyncExternalStore } from 'react'
import type { PersonalHistoryRecord } from '../historyContract'
import { historyDateInput, historyDateRange, type PersonalHistoryWorkspace } from './history'

function duration(seconds: number) {
  if (seconds > 0 && seconds < 1) return 'Less than 1s'
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
const time = (milliseconds: number, withSeconds = false) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: withSeconds ? 'medium' : 'short' }).format(new Date(milliseconds))
const metric = (value: number | null, unit: string) => value === null ? 'Unavailable' : `${value.toLocaleString()} ${unit}`

function Recording({ record, startsAt, endsAt }: { record: PersonalHistoryRecord, startsAt: number, endsAt: number }) {
  const payload = record.payload
  const title = payload.kind === 'presence' ? 'Bed presence' : payload.kind === 'vitals' ? 'Pod vitals' : 'Movement'
  const shortInterval = record.endsAt - record.startsAt < 60000
  return (
    <li className="history-record">
      <div className="row">
        <h3>{title}</h3>
        <span className="pill">
          Pod · recorded
          {' '}
          {record.recordedSide === 'left' ? 'Left' : 'Right'}
        </span>
      </div>
      <p className="history-interval">
        <time dateTime={new Date(record.startsAt).toISOString()}>{time(record.startsAt, shortInterval)}</time>
        {' '}
        →
        {' '}
        <time dateTime={new Date(record.endsAt).toISOString()}>{time(record.endsAt, shortInterval)}</time>
      </p>
      {payload.kind === 'presence' && (
        <>
          <strong className="history-value">{duration(payload.reportedPresenceSeconds)}</strong>
          <p>
            Recorded bed presence ·
            {' '}
            {payload.exits}
            {' '}
            bed
            {' '}
            {payload.exits === 1 ? 'exit' : 'exits'}
          </p>
          <p className="small">
            This is time detected in bed, not confirmed sleep. The complete recording spans
            {' '}
            {duration((record.endsAt - record.startsAt) / 1000)}
            .
          </p>
        </>
      )}
      {payload.kind === 'vitals' && (
        <>
          <dl className="history-metrics">
            <div>
              <dt>Heart rate</dt>
              <dd>{metric(payload.heartRateBpm, 'bpm')}</dd>
            </div>
            <div>
              <dt>Breathing rate</dt>
              <dd>{metric(payload.breathingRatePerMinute, 'breaths/min')}</dd>
            </div>
            <div>
              <dt>Pod HRV</dt>
              <dd>{metric(payload.hrvMs, 'ms')}</dd>
            </div>
          </dl>
          <p className="small">
            {payload.hrvMetric === 'window_ibi_variability_v1' ? 'HRV: variability within the Pod’s measurement window. This differs from Apple Watch HRV.' : 'HRV calculation method is unknown; do not compare it with Apple Watch HRV.'}
            {' '}
            Signal quality is not supplied by this recording.
          </p>
        </>
      )}
      {payload.kind === 'movement' && (
        <>
          <strong className="history-value">{payload.total.toLocaleString()}</strong>
          <p>Recorded movement total · not a sleep stage</p>
        </>
      )}
      {(record.startsAt < startsAt || record.endsAt > endsAt) && <p className="small history-overlap">This complete recording extends outside your chosen dates. Its full duration is not a total for that smaller period.</p>}
      <details>
        <summary>About this recording</summary>
        <p className="small">
          {record.attribution.mode === 'solo_merged' ? 'One sleeper, combined sensor zones.' : 'Recorded during a reviewed side assignment.'}
          {' '}
          Ownership follows your profile when you change sides. Bed sensors do not identify people.
        </p>
        <p className="small">{record.attribution.basis === 'legacy_owner_review' ? 'Earlier history explicitly reviewed by the original owner.' : 'Attributed using the reviewed arrangement for this recording’s dates.'}</p>
      </details>
    </li>
  )
}

export function HistoryPanel({ history }: { history: PersonalHistoryWorkspace }) {
  const state = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const page = state.page
  const [dates, setDates] = useState(() => {
    const last = new Date(), first = new Date(last)
    first.setDate(first.getDate() - 6)
    return { first: historyDateInput(first), last: historyDateInput(last) }
  })
  const [kind, setKind] = useState<'presence' | 'vitals' | 'movement'>('presence')
  const [inputError, setInputError] = useState<string | null>(null)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const load = () => {
    try {
      const range = historyDateRange(dates.first, dates.last)
      setInputError(null)
      void history.load({ ...range, kind, limit: 30 })
    }
    catch (error) { setInputError(error instanceof Error ? error.message : 'Choose valid dates.') }
  }
  const changeDate = (key: 'first' | 'last', value: string) => {
    history.clear()
    setInputError(null)
    setDates(current => ({ ...current, [key]: value }))
  }
  return (
    <article className="history-panel" aria-label="Your private recordings">
      <div className="row">
        <div>
          <p className="eyebrow">Sleep · your private recordings</p>
          <h2>History that stays yours.</h2>
        </div>
        <span className="pill">Pod recordings</span>
      </div>
      <p>Browse your bed-presence, vital and movement recordings. Apple Health records and confirmed sleep stages are not included in this view.</p>
      {!state.available && <p className="notice">Personal history is not enabled on this Pod yet. You can check again below; this does not turn it on or import existing recordings.</p>}
      <form onSubmit={(event) => {
        event.preventDefault()
        load()
      }}
      >
        <div className="history-filters">
          <label>
            From date
            <input type="date" value={dates.first} required onChange={event => changeDate('first', event.target.value)} />
          </label>
          <label>
            Through date
            <input type="date" value={dates.last} required onChange={event => changeDate('last', event.target.value)} />
          </label>
          <label>
            Recording type
            <select
              value={kind}
              onChange={(event) => {
                history.clear()
                setInputError(null)
                setKind(event.target.value as typeof kind)
              }}
            >
              <option value="presence">Bed presence</option>
              <option value="vitals">Pod vitals</option>
              <option value="movement">Movement</option>
            </select>
          </label>
        </div>
        <p className="small">
          Dates and times use this device’s timezone:
          {' '}
          {zone}
          . Choose up to 90 days at a time, including earlier history.
        </p>
        <button type="submit" className="primary" disabled={state.busy}>{state.busy ? 'Reading your history…' : state.page ? 'Reload latest recordings' : state.available ? 'View my recordings' : 'Check history availability'}</button>
      </form>
      {(inputError || state.error) && <p role="alert" className="notice">{inputError ?? state.error}</p>}
      {page && (
        <>
          <p className="small" aria-live="polite">
            Page
            {' '}
            {state.pageNumber}
            {' '}
            ·
            {' '}
            {page.records.length}
            {' '}
            {page.records.length === 1 ? 'recording' : 'recordings'}
            {' '}
            · snapshot read
            {' '}
            {time(page.generatedAt)}
            . This is not a live feed or a sleep-duration total.
          </p>
          {page.records.length === 0
            ? (
                <div className="history-empty">
                  <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true">
                    <rect x="18" y="8" width="84" height="60" rx="14" />
                    <path d="M18 32h84M60 8v60M26 68v8m68-8v8" />
                    <rect x="26" y="16" width="26" height="10" rx="4" />
                    <rect x="68" y="16" width="26" height="10" rx="4" />
                  </svg>
                  <h3>No attributed recordings for these dates</h3>
                  <p>This does not mean you slept zero hours. New accounts do not automatically claim earlier bed-side data.</p>
                </div>
              )
            : <ol className="history-list" aria-label="Private Pod recordings">{page.records.map(record => <Recording key={record.id} record={record} startsAt={page.query.startsAt} endsAt={page.query.endsAt} />)}</ol>}
          {page.nextCursor && <button type="button" disabled={state.busy} onClick={() => void history.older()}>Show older recordings</button>}
          <p className="small">Older pages replace this list. Reload latest starts a fresh snapshot. Nothing here changes the bed or your alarm.</p>
        </>
      )}
    </article>
  )
}
