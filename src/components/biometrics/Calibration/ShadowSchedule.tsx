'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import type { z } from 'zod'
import type { preparedShadowPlanSchema } from '@/src/biometrics/shadow/preparation-contracts'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, InlineError, Skeleton } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { readShadowScheduleRecovery, saveShadowScheduleRecovery, clearShadowScheduleRecovery } from './shadow-schedule-recovery'

/** Explicit UTC, including short qualification windows; reject date rollover. */
function utcInput(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value)
  if (!match) return null
  const iso = `${match[1]}:${match[2] ?? '00'}.${(match[3] ?? '').padEnd(3, '0')}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : null
}
type Prepared = z.infer<typeof preparedShadowPlanSchema>
const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false
export function ShadowSchedule({ side }: { side: 'left' | 'right' }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
  return hydrated ? <ShadowScheduleForm key={side} side={side} /> : <Skeleton className="h-24" />
}
function ShadowScheduleForm({ side }: { side: 'left' | 'right' }) {
  const [recovery] = useState(() => {
    try {
      return { value: readShadowScheduleRecovery(window.sessionStorage, side), error: false }
    }
    catch { return { value: undefined, error: true } }
  })
  const { t } = useLingui()
  const [templateId, setTemplate] = useState('')
  const [subjectId, setSubject] = useState('')
  const [candidate, setCandidate] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [cursor, setCursor] = useState<{ createdAtMs: number, id: string }>()
  const [prepared, setPrepared] = useState<Prepared | undefined>(recovery.value?.prepared)
  const [attempted, setAttempted] = useState(Boolean(recovery.value))
  const [saved, setSaved] = useState<string>()
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  const request = useRef<{ plan: Prepared['plan'], idempotencyKey: string } | undefined>(recovery.value ? { plan: recovery.value.prepared.plan, idempotencyKey: recovery.value.idempotencyKey } : undefined)
  const templates = trpc.biometricShadow.templates.useQuery({})
  const profiles = trpc.biometricTuning.listProfileRevisions.useQuery({ side, beforeCreatedAtMs: cursor?.createdAtMs, beforeId: cursor?.id }, { enabled: Boolean(templates.data?.items.length) })
  const prepare = trpc.biometricShadow.prepare.useMutation()
  const create = trpc.biometricShadow.create.useMutation()
  const utils = trpc.useUtils()
  const busy = prepare.isPending || create.isPending
  const startMs = utcInput(start), endMs = utcInput(end)
  const template = templates.data?.items.find(item => item.id === templateId)
  const valid = Boolean(template && subjectId.trim() && candidate && startMs !== null && endMs !== null
    && endMs > startMs && endMs - startMs <= template.maximumWindowMs)

  function edit(change: () => void) {
    if (pending.current || request.current) return
    change()
    setPrepared(undefined)
    setError(undefined)
  }
  async function review() {
    if (pending.current || request.current || !valid || startMs === null || endMs === null) return
    if (startMs <= Date.now()) {
      setError(t`Choose a start time in the future.`)
      return
    }
    pending.current = true
    setError(undefined)
    setPrepared(undefined)
    try {
      const result = await prepare.mutateAsync({ templateId, side, subjectId, candidateRevisionId: candidate === 'default' ? null : candidate, startMs, endMs })
      setPrepared(result)
    }
    catch { setError(t`The plan could not be prepared. Check the selected profile, window and installed qualification.`) }
    finally { pending.current = false }
  }
  async function schedule() {
    if (pending.current || recovery.error || !prepared || saved) return
    pending.current = true
    setError(undefined)
    try {
      request.current ??= { plan: structuredClone(prepared.plan), idempotencyKey: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('') }
      setAttempted(true)
      saveShadowScheduleRecovery(window.sessionStorage, side, { version: 1, prepared, idempotencyKey: request.current.idempotencyKey })
    }
    catch {
      setError(t`The request could not be saved for recovery. This attempt was not sent. Keep this tab open and retry the same request.`)
      pending.current = false
      return
    }
    try {
      const result = await create.mutateAsync(request.current)
      clearShadowScheduleRecovery(window.sessionStorage, side)
      setSaved(result.id)
      void utils.biometricShadow.list.invalidate({ side })
    }
    catch (failure) {
      const code = typeof failure === 'object' && failure !== null && 'data' in failure
        && typeof failure.data === 'object' && failure.data !== null && 'code' in failure.data
        ? failure.data.code
        : undefined
      if (code === 'BAD_REQUEST' || code === 'PAYLOAD_TOO_LARGE') {
        try {
          clearShadowScheduleRecovery(window.sessionStorage, side)
        }
        catch {
          setError(t`The rejected request could not be cleared from browser recovery. Keep this tab open and retry.`)
          return
        }
        request.current = undefined
        setAttempted(false)
        setPrepared(undefined)
        setError(t`The pod rejected this plan. Adjust it and prepare again.`)
      }
      else setError(t`Scheduling was not confirmed. Retry this same request to learn its outcome; do not assume a run was created or stopped.`)
    }
    finally { pending.current = false }
  }
  const queryError = templates.error ?? profiles.error
  if (recovery.error) return <InlineError>{t`Scheduling recovery is unavailable or invalid. Review existing runs before clearing this tab’s session data; an earlier request may have been saved on the pod.`}</InlineError>
  if (!prepared && queryError) return <InlineError>{queryError.message}</InlineError>
  if (!prepared && !templates.data) return <Skeleton className="h-24" />
  if (!prepared && !templates.data?.items.length) return <p><Trans>No prospective observation templates are configured on this pod.</Trans></p>
  if (!prepared && !profiles.data) return <Skeleton className="h-24" />
  return (
    <section aria-label={t`Schedule an observation`} className="space-y-3">
      <h4><Trans>Schedule an observation</Trans></h4>
      {attempted ? <p><Trans>This tab retains the exact scheduling request across reloads until its outcome is confirmed. Retry does not prepare a new plan.</Trans></p> : null}
      <fieldset disabled={busy || attempted} className="space-y-3">
        <label className="block">
          <Trans>Observation template</Trans>
          <select className="ml-2 rounded border p-2" value={templateId} onChange={event => edit(() => setTemplate(event.target.value))}>
            <option value="">{t`Choose a template`}</option>
            {templates.data?.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        {template ? <p>{t`Maximum window: ${template.maximumWindowMs / 60000} minutes.`}</p> : null}
        <label className="block">
          <Trans>Sleeper identity</Trans>
          <input className="ml-2 rounded border p-2" value={subjectId} maxLength={200} onChange={event => edit(() => setSubject(event.target.value))} />
        </label>
        <p><Trans>Use the same sleeper identity as the reference records you intend to compare.</Trans></p>
        <fieldset className="space-y-2">
          <legend><Trans>Candidate profile</Trans></legend>
          <label className="block">
            <input type="radio" name={`shadow-candidate-${side}`} checked={candidate === 'default'} onChange={() => edit(() => setCandidate('default'))} />
            {' '}
            <Trans>System defaults</Trans>
          </label>
          {profiles.data?.items.map(profile => (
            <label key={profile.id} className="block break-all">
              <input type="radio" name={`shadow-candidate-${side}`} checked={candidate === profile.id} onChange={() => edit(() => setCandidate(profile.id))} />
              {' '}
              {t`Candidate revision ${profile.revision}: ${profile.id}`}
            </label>
          ))}
          {cursor ? <Button onClick={() => setCursor(undefined)}><Trans>Newest profiles</Trans></Button> : null}
          {profiles.data?.nextCursor ? <Button onClick={() => setCursor(profiles.data?.nextCursor ?? undefined)}><Trans>Older profiles</Trans></Button> : null}
        </fieldset>
        <label className="block">
          <Trans>Start (UTC)</Trans>
          <input className="ml-2 rounded border p-2" type="datetime-local" step={0.001} value={start} onChange={event => edit(() => setStart(event.target.value))} />
        </label>
        <label className="block">
          <Trans>End (UTC)</Trans>
          <input className="ml-2 rounded border p-2" type="datetime-local" step={0.001} value={end} onChange={event => edit(() => setEnd(event.target.value))} />
        </label>
        <p><Trans>Choose a future window within the template limit. Preparing a plan does not schedule it.</Trans></p>
        <Button disabled={!valid} onClick={() => void review()}><Trans>Prepare observation plan</Trans></Button>
      </fieldset>
      {prepared
        ? (
            <div className="space-y-2">
              <h5><Trans>Review prepared plan</Trans></h5>
              <p><Trans>Prepared, not admitted. The pod checks current qualification and health again when scheduling and when execution starts.</Trans></p>
              <p>{t`Sleeper: ${prepared.plan.subjectId}`}</p>
              <p>
                <Trans>Prepared window (UTC)</Trans>
                {': '}
                {new Date(prepared.plan.startMs).toISOString()}
                {' – '}
                {new Date(prepared.plan.endMs).toISOString()}
              </p>
              <p>{t`Active generations: left ${prepared.plan.expectedBindings.left.generation}, right ${prepared.plan.expectedBindings.right.generation}.`}</p>
              <p className="break-all text-xs">{t`Candidate hash: ${prepared.plan.candidateConfigHash}`}</p>
              <p className="break-all text-xs">{t`Plan hash: ${prepared.planHash}`}</p>
              <Button disabled={busy || Boolean(saved)} onClick={() => void schedule()}>{attempted ? <Trans>Retry same scheduling request</Trans> : <Trans>Schedule reviewed observation</Trans>}</Button>
            </div>
          )
        : null}
      {error ? <InlineError>{error}</InlineError> : null}
      {saved ? <p role="status">{t`Observation request saved: ${saved}. Review its status in the run list; execution is not implied.`}</p> : null}
      {saved
        ? (
            <Button onClick={() => {
              request.current = undefined
              setAttempted(false)
              setPrepared(undefined)
              setSaved(undefined)
            }}
            >
              <Trans>New observation plan</Trans>
            </Button>
          )
        : null}
    </section>
  )
}
