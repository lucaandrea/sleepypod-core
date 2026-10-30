import { personalRoutinePublishSchema, type PersonalRoutineReview, type PersonalRoutineReceipt } from '../routineContract'
import { personalRoutinesResponseSchema, personalWeekSchema, type HouseholdSession } from '../contract'
import { personalControlRequestSchema, type PersonalControlAction, type PersonalControlReceipt } from '../controlContract'
import type { PersonalBed } from '../bedContract'
import { normalizeBedtimeDraft, validateBedtimeWeek } from '@/src/lib/bedtimeRoutines'
import { controlReference, publicationReference, readOwnReceipt, receiptResolved, identifier, scopeMatches, readPersonalBed, samePersonSession, readRoutineReview, PersonalWebError, type RecoveryReference } from './protocol'
import type { RecoveryJournal } from './recovery'
import type { PersonalWebTransport } from './client'
export type PersonalWeek = PersonalRoutineReview['draftWeek']
export type PersonalResult = PersonalControlReceipt | PersonalRoutineReceipt
export interface PersonalWebState {
  bed: PersonalBed | null
  fresh: boolean
  scopeNeedsReview: boolean
  draftLoad: number
  drafts: ReturnType<typeof personalRoutinesResponseSchema.parse> | null
  review: PersonalRoutineReview | null
  references: RecoveryReference[]
  results: Record<string, PersonalResult>
  message: string
  error: string | null
  busy: string[]
  storageReady: boolean
  now: number
}
interface Dependencies {
  session: HouseholdSession
  client: PersonalWebTransport
  journal: RecoveryJournal
  invalidated: () => void
  now?: () => number
  uptime?: () => number
}
const isStopping = (action: PersonalControlAction) => action.kind === 'vibration.clear' || (action.kind === 'power' && !action.powered)
/** One scoped view owns async generations; only an explicit action may issue a POST. */
export class PersonalWebWorkspace {
  private generation = 0
  private readGeneration = 0
  private controlEpoch = 0
  private draftReadGeneration = 0
  private receivedUptime: number | null = null
  private subscribers = new Set<() => void>()
  private readonly now: () => number
  private readonly uptime: () => number
  private disposed = false
  private activeReferences = new Set<string>()
  private receiptReads = new Map<string, number>()
  private state: PersonalWebState
  constructor(readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now
    this.uptime = dependencies.uptime ?? (() => performance.now())
    this.state = { bed: null, fresh: false, scopeNeedsReview: false, draftLoad: 0, drafts: null, review: null, references: [], results: {},
      message: '', error: null, busy: [], storageReady: false, now: this.now() }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private update(patch: Partial<PersonalWebState>) {
    if (!this.disposed) {
      this.state = { ...this.state, ...patch }
      this.subscribers.forEach(listener => listener())
    }
  }

  private check(generation: number) {
    if (this.disposed || generation !== this.generation)
      throw new PersonalWebError('account_changed', 'The personal workspace changed.')
  }

  private async session(generation: number) {
    const session = samePersonSession(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.check(generation)
    return session
  }

  private async references(generation: number, reading: number) {
    try {
      const references = await this.dependencies.journal.list(this.dependencies.session)
      this.check(generation)
      if (reading !== this.readGeneration) return
      this.update({ references, storageReady: true })
    }
    catch (error) {
      if (reading === this.readGeneration) this.update({ storageReady: false })
      throw error
    }
  }

  private fail(error: unknown) {
    if (this.disposed)
      return
    this.update({ error: error instanceof PersonalWebError ? error.message : 'The result could not be verified. Refresh and check saved results before another change.' })
    if (error instanceof PersonalWebError && ['authentication', 'account_changed'].includes(error.code)) {
      this.dispose()
      this.dependencies.invalidated()
    }
  }

  async start() {
    await this.refresh(true)
  }

  async refresh(includeDrafts = false) {
    if (this.disposed || this.state.busy.includes('refresh') || this.activeReferences.size || (includeDrafts && this.state.busy.includes('draft')))
      return
    const generation = this.generation, reading = ++this.readGeneration
    this.update({ busy: [...this.state.busy, 'refresh'] })
    try {
      const session = await this.session(generation)
      const bed = readPersonalBed(await this.dependencies.client.read('me/bed'), session)
      this.check(generation)
      if (reading !== this.readGeneration)
        return
      this.receivedUptime = this.uptime()
      this.update({ bed, scopeNeedsReview: this.state.scopeNeedsReview || (this.state.bed !== null && JSON.stringify(this.state.bed.scope) !== JSON.stringify(bed.scope)) })
      this.tick()
      if (includeDrafts || !this.state.drafts)
        await this.loadDrafts(generation)
      if (reading !== this.readGeneration) return
      await this.references(generation, reading)
    }
    catch (error) {
      if (reading === this.readGeneration) {
        this.update({ fresh: false })
        this.fail(error)
      }
    }
    finally {
      this.update({ busy: this.state.busy.filter(value => value !== 'refresh') })
    }
  }

  private async loadDrafts(generation: number) {
    const reading = ++this.draftReadGeneration
    this.update({ busy: [...this.state.busy, 'draft-reload'] })
    try {
      const drafts = personalRoutinesResponseSchema.parse(await this.dependencies.client.read('me/routines'))
      this.check(generation)
      if (drafts.sleeperId !== this.dependencies.session.selfSleeperId || drafts.status !== 'draft_only')
        throw new PersonalWebError('account_changed', 'This routine response does not belong to your draft workspace.')
      if (reading === this.draftReadGeneration) this.update({ drafts, draftLoad: this.state.draftLoad + 1 })
      return drafts
    }
    finally { this.update({ busy: this.state.busy.filter(value => value !== 'draft-reload') }) }
  }

  tick() {
    const now = this.now(), bed = this.state.bed
    const age = this.receivedUptime === null ? Number.NaN : this.uptime() - this.receivedUptime
    const observationAge = bed?.observation.observedAt === null || !bed ? Number.NaN : now - bed.observation.observedAt
    const fresh = bed?.observation.state === 'fresh' && age >= 0 && age < 15000 && observationAge >= 0 && observationAge < 15000
    if (!fresh)
      this.receivedUptime = null
    this.update({ fresh: !!fresh, now })
  }

  reviewScope() {
    if (this.state.bed?.availability === 'ready')
      this.update({ scopeNeedsReview: false, error: null })
  }

  canControl(stopping = false) {
    return this.state.storageReady && this.state.bed?.availability === 'ready'
      && (stopping || (this.state.fresh && this.state.bed.observation.water === 'ok' && this.state.bed.observation.priming === false && !this.state.scopeNeedsReview && !this.state.references.length
        && !this.state.busy.includes('control')))
  }

  async control(action: PersonalControlAction) {
    if (isStopping(action)) ++this.controlEpoch
    const epoch = this.controlEpoch
    if (!this.canControl(isStopping(action)))
      return
    const reviewed = this.state.bed
    if (!reviewed)
      return
    const generation = this.generation
    const operation = isStopping(action) ? action.kind === 'power' ? 'stop-power' : 'stop-vibration' : 'control'
    if (this.state.busy.includes(operation))
      return
    ++this.readGeneration
    this.update({ busy: [...this.state.busy, operation], error: null })
    try {
      const session = await this.session(generation)
      const bed = readPersonalBed(await this.dependencies.client.read('me/bed'), session)
      this.check(generation)
      if (bed.availability !== 'ready' || JSON.stringify(bed.scope) !== JSON.stringify(reviewed.scope)) {
        this.update({ bed, scopeNeedsReview: true })
        throw new PersonalWebError('conflict', 'The bed configuration changed. Review the current bed before sending a new action.')
      }
      const now = this.now()
      const request = personalControlRequestSchema.parse({ version: 1, requestId: identifier(), scope: bed.scope,
        issuedAt: now, expiresAt: now + 30000, action })
      this.receivedUptime = this.uptime()
      this.update({ bed })
      this.tick()
      if (!isStopping(action) && (!this.state.fresh || bed.observation.water !== 'ok' || bed.observation.priming !== false))
        throw new PersonalWebError('observation', 'Fresh water and priming status are required before another temperature change.')
      const zones = action.kind === 'temperature' ? bed.routing.temperature : action.kind === 'power' ? bed.routing.power : bed.routing.vibrationCancellation
      const reference = controlReference(session, request, zones)
      await this.send(reference, () => this.dependencies.client.read('me/controls', 'POST', request), generation, isStopping(action), () => {
        if (!isStopping(action) && epoch !== this.controlEpoch) throw new PersonalWebError('superseded', 'The unsent adjustment was canceled by Stop.')
      })
    }
    catch (error) {
      this.fail(error)
    }
    finally {
      this.update({ busy: this.state.busy.filter(value => value !== operation) })
    }
  }

  private async send(reference: RecoveryReference, post: () => Promise<unknown>, generation: number, allowAdditional = false, beforePost: () => void = () => {
  }) {
    await this.dependencies.journal.reserve(reference, allowAdditional)
    this.check(generation)
    if (this.now() >= reference.expiresAt)
      throw new PersonalWebError('expired', 'The request expired before sending. Its saved reference can be reviewed without a retry.')
    this.activeReferences.add(reference.requestId)
    this.update({ references: [...this.state.references, reference] })
    try {
      // Stop may arrive while durable reservation is still pending. Only discard
      // this reference when we know the POST has not started.
      try {
        beforePost()
      }
      catch (error) {
        await this.dependencies.journal.remove(reference)
        this.update({ references: this.state.references.filter(value => value.requestId !== reference.requestId) })
        throw error
      }
      const input = await post()
      this.check(generation)
      // Supersede an older GET still in flight for this same receipt.
      this.receiptReads.set(reference.requestId, (this.receiptReads.get(reference.requestId) ?? 0) + 1)
      await this.accept(input, reference, generation)
    }
    finally {
      this.activeReferences.delete(reference.requestId)
    }
  }

  private async accept(input: unknown, reference: RecoveryReference, generation: number) {
    const receipt = readOwnReceipt(input, reference, this.dependencies.session)
    this.check(generation)
    this.update({ results: Object.fromEntries([...Object.entries(this.state.results).filter(([key]) => key !== reference.requestId).slice(-19), [reference.requestId, receipt]]), message: receipt.state === 'saved'
      ? receipt.scheduler === 'refreshed' ? 'Your operating routine was saved and registered with the scheduler.' : 'Your routine was saved. Scheduler registration is not yet confirmed.'
      : receipt.state === 'acknowledged'
        ? 'The controller acknowledged your request. Check the bed for its physical response.'
        : ['expired', 'rejected', 'not_dispatched'].includes(receipt.state) ? 'No hardware write was made for this request.' : 'The outcome is still uncertain. Check the result before another adjustment.' })
    if (receiptResolved(receipt)) {
      await this.dependencies.journal.remove(reference)
      this.check(generation)
      this.update({ references: this.state.references.filter(value => value.requestId !== reference.requestId) })
    }
  }

  async reconcile(reference: RecoveryReference) {
    if (this.disposed || !this.state.references.some(value => value.requestId === reference.requestId))
      return
    const generation = this.generation, reading = (this.receiptReads.get(reference.requestId) ?? 0) + 1
    this.receiptReads.set(reference.requestId, reading)
    this.update({ error: null })
    try {
      // Re-pairing may restore this person's old reference after their assignment changed.
      await this.session(generation)
      const path = reference.kind === 'control' ? `me/controls/${reference.requestId}` : `me/routines/publications/${reference.requestId}`
      const input = await this.dependencies.client.read(path)
      this.check(generation)
      if (this.receiptReads.get(reference.requestId) !== reading)
        return
      await this.accept(input, reference, generation)
    }
    catch (error) {
      if (this.receiptReads.get(reference.requestId) === reading)
        this.fail(error)
    }
  }

  canMarkReviewed(reference: RecoveryReference) {
    const receipt = this.state.results[reference.requestId]
    return this.state.now >= reference.expiresAt && !this.activeReferences.has(reference.requestId)
      && !(receipt?.state === 'executing' || (receipt?.state === 'saved' && receipt.scheduler === 'pending'))
  }

  async markReviewed(reference: RecoveryReference) {
    if (!this.canMarkReviewed(reference))
      return
    const generation = this.generation
    try {
      await this.session(generation)
      await this.dependencies.journal.remove(reference)
      this.check(generation)
      this.update({ references: this.state.references.filter(value => value.requestId !== reference.requestId),
        message: 'Marked as reviewed by you. This does not confirm an unknown result or resend anything.' })
    }
    catch (error) {
      this.fail(error)
    }
  }

  async saveDraft(week: PersonalWeek) {
    if (!this.state.drafts || this.state.busy.includes('draft'))
      return false
    const generation = this.generation, expectedRevision = this.state.drafts.revision
    ++this.readGeneration
    ++this.draftReadGeneration
    this.update({ busy: [...this.state.busy, 'draft'], error: null, review: null })
    try {
      const routines = personalWeekSchema.parse(week)
      try {
        validateBedtimeWeek('left', routines)
      }
      catch (error) {
        throw new PersonalWebError('draft_invalid', error instanceof Error ? error.message : 'The draft week is invalid.')
      }
      const session = await this.session(generation)
      const input = { requestId: identifier(), expectedSessionRevision: session.sessionRevision,
        expectedAssignmentRevision: session.assignmentRevision, expectedRevision, routines }
      const saved = personalRoutinesResponseSchema.parse(await this.dependencies.client.read('me/routines', 'PUT', input))
      this.check(generation)
      if (saved.sleeperId !== session.selfSleeperId || saved.status !== 'draft_only')
        throw new PersonalWebError('account_changed', 'The saved draft belongs to another context.')
      this.update({ drafts: saved, message: 'Private draft saved. Your operating routine and alarm have not changed.' })
      return true
    }
    catch (error) {
      this.fail(error)
      return false
    }
    finally {
      this.update({ busy: this.state.busy.filter(value => value !== 'draft') })
    }
  }

  async reviewRoutine() {
    if (this.state.busy.includes('review'))
      return null
    const generation = this.generation
    this.update({ busy: [...this.state.busy, 'review'], error: null })
    try {
      const session = await this.session(generation)
      if (!session.capabilities.personalRoutinePublication)
        throw new PersonalWebError('unavailable', 'Routine publication is not enabled for this account yet. You can continue preparing your private draft.')
      const review = readRoutineReview(await this.dependencies.client.read('me/routines/review'), session)
      this.check(generation)
      if (!scopeMatches(review.scope, session))
        throw new PersonalWebError('account_changed', 'The routine review belongs to another context.')
      this.update({ review })
      return review
    }
    catch (error) {
      this.fail(error)
      return null
    }
    finally {
      this.update({ busy: this.state.busy.filter(value => value !== 'review') })
    }
  }

  async publish(review: PersonalRoutineReview, acknowledgments: {
    replaceWeek: boolean
    currentEffect: boolean
  }) {
    if (!acknowledgments.replaceWeek || !acknowledgments.currentEffect || !review.canPublish || this.state.busy.includes('publication') || !this.state.storageReady
      || this.state.references.length)
      return
    const generation = this.generation, epoch = this.controlEpoch
    this.update({ busy: [...this.state.busy, 'publication'], error: null })
    try {
      const current = await this.reviewRoutine()
      this.check(generation)
      if (!current || current.reviewRevision !== review.reviewRevision)
        throw new PersonalWebError('conflict', 'The reviewed draft or operating week changed. Read the new comparison before publishing.')
      const now = this.now()
      const request = personalRoutinePublishSchema.parse({ version: 1, requestId: identifier(), scope: review.scope,
        issuedAt: now, expiresAt: now + 30000, reviewRevision: review.reviewRevision,
        confirmReplaceLiveWeek: true, acknowledgeCurrentTargetEffect: true })
      const reference = publicationReference(this.dependencies.session, request, review)
      await this.send(reference, () => this.dependencies.client.read('me/routines/publish', 'POST', request), generation, false, () => {
        if (epoch !== this.controlEpoch) throw new PersonalWebError('superseded', 'The unsent publication was canceled by Stop. Review again before publishing.')
      })
      this.update({ review: null })
    }
    catch (error) {
      this.fail(error)
    }
    finally {
      this.update({ busy: this.state.busy.filter(value => value !== 'publication') })
    }
  }

  dispose() {
    this.disposed = true
    this.generation++
    this.readGeneration++
    this.dependencies.client.dispose()
    this.subscribers.clear()
    this.state = { ...this.state, bed: null, drafts: null, review: null, references: [], results: {}, message: '', error: null, fresh: false }
  }
}
export const weekCopy = (week: PersonalWeek): PersonalWeek => week.map(entry => ({ dayOfWeek: entry.dayOfWeek, draft: normalizeBedtimeDraft(entry.draft) }))
