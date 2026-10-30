import type { HouseholdSession } from '../contract'
import { personalHistoryPageSchema, type PersonalHistoryPage } from '../historyApiContract'
import { personalHistoryQuerySchema, type PersonalHistoryQuery } from '../historyContract'
import type { PersonalWebTransport } from './client'
import { PersonalWebError, samePersonSession } from './protocol'

const scope = (session: HouseholdSession) => ({ podId: session.podId, householdId: session.householdId,
  accountId: session.accountId, sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
  householdRevision: session.householdRevision, assignmentRevision: session.assignmentRevision })
const sameScope = (first: ReturnType<typeof scope>, second: ReturnType<typeof scope>) => Object.entries(first).every(([key, value]) => second[key as keyof typeof second] === value)
export interface PersonalHistoryState {
  page: PersonalHistoryPage | null
  pageNumber: number
  busy: boolean
  available: boolean
  error: string | null
}
interface Dependencies {
  session: HouseholdSession
  client: PersonalWebTransport
  invalidated: () => void
}

/** One in-memory page owns an independent request generation; it never blocks Stop. */
export class PersonalHistoryWorkspace {
  private generation = 0
  private disposed = false
  private checking = false
  private query: PersonalHistoryQuery | null = null
  private cursors = new Set<string>()
  private recordIds = new Set<string>()
  private listeners = new Set<() => void>()
  private state: PersonalHistoryState
  constructor(private readonly dependencies: Dependencies) {
    this.state = { page: null, pageNumber: 0, busy: false, available: dependencies.session.capabilities.personalHistory, error: null }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<PersonalHistoryState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  private current(generation: number) {
    if (this.disposed || generation !== this.generation) throw new PersonalWebError('superseded', 'A newer history request replaced this one.')
  }

  clear() {
    ++this.generation
    this.query = null
    this.cursors.clear()
    this.recordIds.clear()
    this.update({ page: null, pageNumber: 0, busy: false, error: null })
  }

  private fail(error: unknown, generation: number) {
    if (this.disposed || generation !== this.generation) return
    const code = error instanceof PersonalWebError ? error.code : null
    this.update({ page: null, pageNumber: 0, busy: false, error: code === 'disabled'
      ? null
      : code === 'page_limit'
        ? 'Choose an earlier date range to continue browsing older recordings.'
        : code === 'conflict'
          ? 'Your recordings or their ownership changed. Load a fresh history before continuing.'
          : 'Your recordings could not be verified. Load a fresh history to try again.' })
    this.query = null
    this.cursors.clear()
    this.recordIds.clear()
    if (error instanceof PersonalWebError && ['authentication', 'account_changed'].includes(error.code)) {
      this.dispose()
      this.dependencies.invalidated()
    }
  }

  private async session(generation: number) {
    const session = samePersonSession(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.current(generation)
    if (!session.capabilities.personalHistory) {
      this.update({ available: false, page: null, pageNumber: 0 })
      throw new PersonalWebError('disabled', 'Personal history is not enabled.')
    }
    this.update({ available: true })
    return session
  }

  async load(input: unknown) {
    if (this.disposed) return
    this.clear()
    const generation = this.generation
    try {
      const query = personalHistoryQuerySchema.parse(input)
      if (query.cursor !== undefined) throw new Error('Start a new history without a cursor')
      this.query = query
      await this.read(query, generation, null)
    }
    catch (error) { this.fail(error, generation) }
  }

  async older() {
    const previous = this.state.page
    if (this.disposed || this.state.busy || !this.query || !previous?.nextCursor) return
    const generation = ++this.generation
    try {
      // Bound cursor bookkeeping as well as displayed records. Earlier date
      // ranges remain available without retaining thousands of private pages.
      if (this.cursors.size >= 256) throw new PersonalWebError('page_limit', 'Choose an earlier date range.')
      await this.read({ ...this.query, cursor: previous.nextCursor }, generation, previous)
    }
    catch (error) { this.fail(error, generation) }
  }

  private async read(query: PersonalHistoryQuery, generation: number, previous: PersonalHistoryPage | null) {
    this.update({ busy: true, error: null })
    try {
      const before = await this.session(generation)
      if (previous && !sameScope(previous.scope, scope(before))) throw new PersonalWebError('conflict', 'History scope changed')
      const search = new URLSearchParams({ startsAt: String(query.startsAt), endsAt: String(query.endsAt), kind: query.kind, limit: String(query.limit) })
      if (query.cursor) search.set('cursor', query.cursor)
      const page = personalHistoryPageSchema.parse(await this.dependencies.client.read(`me/sleep?${search}`))
      this.current(generation)
      const after = await this.session(generation)
      if (!sameScope(scope(before), scope(after)) || !sameScope(page.scope, scope(after)))
        throw new PersonalWebError('account_changed', 'The history response belongs to a different account context.')
      if (page.query.startsAt !== query.startsAt || page.query.endsAt !== query.endsAt || page.query.kind !== query.kind || page.query.limit !== query.limit
        || (previous && page.attributionRevision !== previous.attributionRevision)
        || (page.nextCursor !== null && (page.nextCursor === query.cursor || this.cursors.has(page.nextCursor)))
        || page.records.some((record, index) => index > 0 && record.startsAt > page.records[index - 1].startsAt)
        || page.records.some(record => this.recordIds.has(record.id))
        || (previous?.records.length && page.records.length && page.records[0].startsAt > previous.records[previous.records.length - 1].startsAt))
        throw new PersonalWebError('conflict', 'The history response changed its snapshot or range.')
      if (query.cursor) this.cursors.add(query.cursor)
      page.records.forEach(record => this.recordIds.add(record.id))
      this.update({ page, pageNumber: previous ? this.state.pageNumber + 1 : 1 })
    }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  /** Periodic account checks withdraw private views after revocation or a switch. */
  async checkAccess() {
    if (this.disposed || this.checking || this.state.busy || !this.state.page) return
    const generation = this.generation
    this.checking = true
    try {
      const current = await this.session(generation)
      if (this.state.page && !sameScope(this.state.page.scope, scope(current))) throw new PersonalWebError('conflict', 'Household context changed')
    }
    catch (error) { this.fail(error, generation) }
    finally { this.checking = false }
  }

  dispose() {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.dependencies.client.dispose()
    this.listeners.clear()
  }
}

export function historyDateInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Calendar dates use this browser's timezone, including daylight-saving boundaries. */
export function historyDateRange(first: string, last: string) {
  const dates = [first, last].map((value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose both dates.')
    const date = new Date(`${value}T00:00:00`)
    if (!Number.isFinite(date.getTime()) || historyDateInput(date) !== value) throw new Error('Choose valid dates.')
    return date
  })
  dates[1].setDate(dates[1].getDate() + 1)
  const range = { startsAt: dates[0].getTime(), endsAt: dates[1].getTime() }
  if (range.endsAt <= range.startsAt) throw new Error('The through date must be on or after the from date.')
  if (range.endsAt - range.startsAt > 90 * 86400_000) throw new Error('Choose a shorter period: the limit is 90 days, and a clock change can add an hour.')
  return range
}
