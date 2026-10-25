import type { Side } from '@/src/hardware/types'
import { comfortConfigSchema, comfortFeedbackSchema, type ComfortStatus } from './contract'
import { comfortLocalDate, decideComfort, learnComfort, MANUAL_PAUSE_MS, type ComfortConfig, type ComfortContext, type ComfortDecision, type ComfortFeedback, type ComfortState } from './policy'
import { comfortEvent, type ComfortStore } from './store'

export const COMFORT_ACTIVATION_REASON = 'Hardware qualification and reviewed Preview nights are pending.' as const
const STORAGE_FAULT = 'Personal comfort is withheld because its current inputs, settings or observation journal are unavailable.'
interface Observation { at: number, decision: ComfortDecision, stateKey: string }
export class ComfortInputError extends Error {}

export interface ComfortRuntimeDeps {
  now(): number
  store: ComfortStore
  withSideLock<T>(side: Side, work: () => Promise<T>): Promise<T>
  readContext(side: Side, state: ComfortState, now: number): { context: ComfortContext, timezone: string }
  timezone(): string
  pendingPause(side: Side): number | null
  acknowledgePause(side: Side, at: number): void
}

/** Preview has no actuator dependency. Only the shared temperature authority may later admit active leases. */
export class ComfortRuntime {
  private observations: Partial<Record<Side, Observation>> = {}
  private recorded: Partial<Record<Side, { at: number, key: string }>> = {}
  private faults: Partial<Record<Side, string>> = {}
  private running = false
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private lastPrunedAt = 0

  constructor(private readonly deps: ComfortRuntimeDeps) {}

  isRunning(): boolean {
    return this.running
  }

  status(side: Side): ComfortStatus {
    let state: ComfortState | null = null
    let history: ComfortStatus['history'] = []
    let timezone: string | null = null
    let deviceDate: string | null = null
    try {
      timezone = this.deps.timezone()
      deviceDate = comfortLocalDate(this.deps.now(), timezone)
      state = this.deps.store.read(side)
      history = this.deps.store.history(side)
    }
    catch { this.faults[side] = STORAGE_FAULT }
    const observation = this.observations[side]
    const fault = this.faults[side] ?? (this.deps.pendingPause(side) !== null ? STORAGE_FAULT : null)
    return {
      apiVersion: 1, generatedAt: this.deps.now(), side, state, history, fault, timezone, deviceDate,
      evaluatedAt: observation?.at ?? null,
      decision: fault || observation?.stateKey !== JSON.stringify(state) ? null : observation?.decision ?? null,
      runtime: this.running ? 'running' : 'stopped',
      activation: { available: false, reason: COMFORT_ACTIVATION_REASON },
      features: { sensorAware: false, followBedtime: false },
    }
  }

  async configure(side: Side, input: ComfortConfig): Promise<ComfortStatus> {
    const config = comfortConfigSchema.parse(input)
    if (config.mode === 'active') throw new Error(COMFORT_ACTIVATION_REASON)
    if (config.sensorAware || config.followBedtime) throw new Error('Sensor-aware and bedtime-phase adapters have not been qualified for Core yet.')
    await this.deps.withSideLock(side, async () => {
      const state = this.recoverPause(side)
      this.deps.store.commit(side, { ...state, config },
        comfortEvent(this.deps.now(), 'configuration', `Personal comfort set to ${config.mode}.`))
      this.observations[side] = undefined
      this.recorded[side] = undefined
      this.faults[side] = undefined
    })
    return this.status(side)
  }

  async feedback(side: Side, input: ComfortFeedback): Promise<ComfortStatus> {
    const feedback = comfortFeedbackSchema.parse(input)
    await this.deps.withSideLock(side, async () => {
      const now = this.deps.now()
      const today = comfortLocalDate(now, this.deps.timezone())
      const since = new Date(Date.parse(today) - 14 * 86_400_000).toISOString().slice(0, 10)
      if (feedback.date > today || feedback.date < since) throw new ComfortInputError('Check-ins must describe today or the previous fourteen local dates.')
      this.recoverPause(side)
      this.deps.store.saveFeedback(side, feedback,
        comfortEvent(now, 'feedback', `${feedback.date}: ${feedback.comfort}.`))
    })
    return this.status(side)
  }

  /** Recover a failed manual-pause write before evaluating or changing consent. */
  private recoverPause(side: Side): ComfortState {
    let state = this.deps.store.read(side)
    const pending = this.deps.pendingPause(side)
    if (pending !== null) {
      state = { ...state, pausedUntil: Math.max(state.pausedUntil, pending + MANUAL_PAUSE_MS) }
      this.deps.store.commit(side, state, comfortEvent(pending, 'manual_pause', 'Recovered the six-hour pause after a manual control.'))
      this.deps.acknowledgePause(side, pending)
    }
    return state
  }

  async evaluate(side: Side): Promise<void> {
    await this.deps.withSideLock(side, async () => {
      try {
        const now = this.deps.now()
        let state = this.recoverPause(side)
        const original = JSON.stringify(state)
        const { context, timezone } = this.deps.readContext(side, state, now)
        // Preview may learn from check-ins, but never records a hardware acknowledgment.
        const learning = state.config.mode === 'preview' && context.window
          ? learnComfort(state, this.deps.store.feedback(side), context.window.session, timezone, now)
          : { state, message: null }
        state = learning.state
        let decision = decideComfort(state, context)
        if (state.config.mode === 'active' || state.config.followBedtime) {
          decision = { ...decision, eligible: false, proposedF: null, retainPreviousLease: false,
            reason: state.config.mode === 'active' ? COMFORT_ACTIVATION_REASON : 'Bedtime-phase mapping is not available in Core Preview yet.' }
        }
        if (decision.pauseRequired) state = { ...state, pausedUntil: Math.max(state.pausedUntil, now + MANUAL_PAUSE_MS) }
        const key = JSON.stringify([decision, context.window?.segment, context.owner, context.device.targetF])
        const previous = this.recorded[side]
        const record = state.config.mode !== 'off' && (!previous || previous.key !== key || now - previous.at >= 60_000 || now < previous.at)
        const event = record
          ? {
              ...comfortEvent(now, 'preview', learning.message ? `${decision.reason} ${learning.message}` : decision.reason),
              session: context.window?.session ?? null, proposedF: decision.proposedF, reportedF: context.device.targetF,
              eligible: decision.eligible, deviceObservedAt: context.device.observedAt,
              presenceObservedAt: context.presence.observedAt, owner: context.owner,
            }
          : undefined
        if (event || JSON.stringify(state) !== original) this.deps.store.commit(side, state, event)
        if (record) this.recorded[side] = { at: now, key }
        this.observations[side] = { at: now, decision, stateKey: JSON.stringify(state) }
        this.faults[side] = undefined
      }
      catch {
        this.faults[side] = STORAGE_FAULT
        this.observations[side] = undefined
      }
    })
  }

  private tick(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      for (const side of ['left', 'right'] as const) {
        if (!this.running) break
        await this.evaluate(side)
      }
      const now = this.deps.now()
      if (this.running && (!this.lastPrunedAt || now - this.lastPrunedAt >= 3_600_000)) {
        try {
          this.deps.store.prune(now)
          this.lastPrunedAt = now
        }
        catch { /* Retain observations; a later tick retries pruning. */ }
      }
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick()
    }, 5_000)
    this.timer.unref()
    await this.tick()
  }

  async stop(): Promise<void> {
    this.running = false
    clearInterval(this.timer)
    await this.pending
  }
}
