import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import history from '../../fixtures/personal-history-v1.json'
import { householdSessionSchema } from '../../contract'
import { personalHistoryPageSchema, type PersonalHistoryPage } from '../../historyApiContract'
import { PersonalHistoryWorkspace, historyDateInput, historyDateRange } from '../history'
import { PersonalWebError } from '../protocol'

function setup() {
  const session = householdSessionSchema.parse({ ...preparation.ownerSession,
    capabilities: { ...preparation.ownerSession.capabilities, personalHistory: true } })
  let response: unknown = structuredClone(history.page)
  const defaultRead = async (path: string): Promise<unknown> => path === 'household/session' ? structuredClone(session) : structuredClone(response)
  const client = {
    dispose: vi.fn(),
    read: vi.fn(defaultRead),
  }
  const invalidated = vi.fn()
  const workspace = new PersonalHistoryWorkspace({ session: structuredClone(session), client, invalidated })
  return { session, client, defaultRead, invalidated, workspace, respond: (value: unknown) => {
    response = value
  } }
}

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((resolved, rejected) => {
    resolve = resolved
    reject = rejected
  })
  return { promise, resolve, reject }
}

function firstPage(): PersonalHistoryPage {
  return personalHistoryPageSchema.parse({ ...history.page, query: { ...history.page.query, limit: 1 }, nextCursor: 'opaque+cursor/with=padding' })
}
function nextPage(previous: PersonalHistoryPage): PersonalHistoryPage {
  const page = structuredClone(previous)
  page.records[0].id = '10000000-0000-4000-8000-000000000099'
  page.records[0].startsAt -= 1000
  page.records[0].payload = { kind: 'presence', reportedPresenceSeconds: 24000, exits: 1, interpretation: 'bed_presence_not_sleep' }
  page.nextCursor = null
  return personalHistoryPageSchema.parse(page)
}

describe('private browser recording history', () => {
  it('preserves the whole overlapping recording and checks the person before and after its read', async () => {
    const fixture = setup()
    await fixture.workspace.load(history.page.query)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ page: history.page, pageNumber: 1, busy: false, error: null })
    const paths = fixture.client.read.mock.calls.map(([path]) => path)
    expect(paths).toHaveLength(3)
    expect(paths[0]).toBe('household/session')
    expect(paths[1]).toMatch(/^me\/sleep\?startsAt=/)
    expect(paths[2]).toBe('household/session')
    expect(fixture.workspace.getSnapshot().page?.records[0].payload).toEqual(history.page.records[0].payload)
  })

  it('treats null vital measurements and a measured zero HRV distinctly', async () => {
    const fixture = setup(), response = structuredClone(history.vitalsPage)
    response.records[0].payload.hrvMs = 0
    fixture.respond(response)
    await fixture.workspace.load(response.query)
    expect(fixture.workspace.getSnapshot().page?.records[0].payload).toMatchObject({ breathingRatePerMinute: null, hrvMs: 0 })
  })

  it('replaces pages, preserves opaque cursor bytes, and refreshes without that cursor', async () => {
    const fixture = setup(), first = firstPage(), second = nextPage(first)
    fixture.respond(first)
    await fixture.workspace.load(first.query)
    fixture.respond(second)
    await fixture.workspace.older()
    expect(fixture.workspace.getSnapshot()).toMatchObject({ page: second, pageNumber: 2 })
    const request = fixture.client.read.mock.calls.find(([path]) => path.includes('cursor='))?.[0] ?? ''
    expect(request).toContain('cursor=opaque%2Bcursor%2Fwith%3Dpadding')
    expect(new URLSearchParams(request.split('?')[1]).get('cursor')).toBe(first.nextCursor)
    fixture.respond(first)
    await fixture.workspace.load(first.query)
    expect(fixture.workspace.getSnapshot().pageNumber).toBe(1)
    expect(fixture.client.read.mock.calls.at(-2)?.[0]).not.toContain('cursor=')
  })

  it.each(['scope', 'attribution', 'query', 'cursor', 'duplicate', 'ordering'] as const)('clears history when a later page changes its %s', async (changed) => {
    const fixture = setup(), first = firstPage(), second = nextPage(first)
    fixture.respond(first)
    await fixture.workspace.load(first.query)
    if (changed === 'scope') second.scope.accountId = '00000000-0000-4000-8000-000000000099'
    if (changed === 'attribution') second.attributionRevision++
    if (changed === 'query') second.query.startsAt++
    if (changed === 'cursor') second.nextCursor = first.nextCursor
    if (changed === 'duplicate') second.records[0].id = first.records[0].id
    if (changed === 'ordering') second.records[0].startsAt = first.records[0].startsAt + 1000
    fixture.respond(second)
    await fixture.workspace.older()
    expect(fixture.workspace.getSnapshot().page).toBeNull()
    expect(fixture.workspace.getSnapshot().pageNumber).toBe(0)
    const calls = fixture.client.read.mock.calls.length
    await fixture.workspace.older()
    expect(fixture.client.read).toHaveBeenCalledTimes(calls)
    expect(fixture.invalidated).toHaveBeenCalledTimes(changed === 'scope' ? 1 : 0)
  })

  it('rejects duplicate or unordered records within the first page', async () => {
    for (const duplicate of [false, true]) {
      const fixture = setup(), response = structuredClone(history.page)
      const second = { ...response.records[0], id: duplicate ? response.records[0].id : '10000000-0000-4000-8000-000000000099', startsAt: response.records[0].startsAt + 1000 }
      response.records.push(second)
      fixture.respond(response)
      await fixture.workspace.load(response.query)
      expect(fixture.workspace.getSnapshot().page).toBeNull()
      expect(fixture.workspace.getSnapshot().error).not.toBeNull()
    }
  })

  it('rejects an ID replayed across nonadjacent pages with equal timestamps', async () => {
    const fixture = setup(), first = firstPage(), second = nextPage(first)
    second.records[0].startsAt = first.records[0].startsAt
    second.nextCursor = 'second-cursor'
    fixture.respond(first)
    await fixture.workspace.load(first.query)
    fixture.respond(second)
    await fixture.workspace.older()
    expect(fixture.workspace.getSnapshot().pageNumber).toBe(2)
    fixture.respond({ ...first, nextCursor: null })
    await fixture.workspace.older()
    expect(fixture.workspace.getSnapshot().page).toBeNull()
    expect(fixture.workspace.getSnapshot().error).toContain('changed')
    fixture.respond(first)
    await fixture.workspace.load(first.query)
    expect(fixture.workspace.getSnapshot().page).toEqual(first)
  })

  it('bounds cursor-chain metadata and allows an earlier-date query to restart browsing', async () => {
    const fixture = setup()
    for (let pageNumber = 0; pageNumber <= 256; pageNumber++) {
      const page = firstPage()
      page.records[0].id = `10000000-0000-4000-8000-${String(pageNumber + 1).padStart(12, '0')}`
      page.nextCursor = `cursor-${pageNumber}`
      fixture.respond(page)
      if (pageNumber === 0) await fixture.workspace.load(page.query)
      else await fixture.workspace.older()
    }
    expect(fixture.workspace.getSnapshot().pageNumber).toBe(257)
    const calls = fixture.client.read.mock.calls.length
    await fixture.workspace.older()
    expect(fixture.client.read).toHaveBeenCalledTimes(calls)
    expect(fixture.workspace.getSnapshot().error).toContain('earlier date range')
    fixture.respond(history.page)
    await fixture.workspace.load(history.page.query)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ page: history.page, pageNumber: 1, error: null })
  })

  it.each(['accountId', 'sessionRevision', 'assignmentRevision', 'householdRevision'] as const)('withdraws a response after an in-flight %s change', async (field) => {
    const fixture = setup(), delayed = deferred()
    fixture.client.read.mockImplementation(path => path.startsWith('me/sleep?') ? delayed.promise : fixture.defaultRead(path))
    const loading = fixture.workspace.load(history.page.query)
    await vi.waitFor(() => expect(fixture.client.read).toHaveBeenCalledTimes(2))
    if (field === 'accountId') fixture.session.accountId = '00000000-0000-4000-8000-000000000099'
    else fixture.session[field]++
    delayed.resolve(history.page)
    await loading
    expect(fixture.workspace.getSnapshot().page).toBeNull()
    expect(fixture.invalidated).toHaveBeenCalledOnce()
    expect(fixture.client.dispose).toHaveBeenCalledOnce()
  })

  it('ignores a late older filter response after newer movement results arrive', async () => {
    const fixture = setup(), delayed = deferred()
    fixture.client.read.mockImplementation(path => path.includes('kind=presence') ? delayed.promise : fixture.defaultRead(path))
    const loading = fixture.workspace.load(history.page.query)
    await vi.waitFor(() => expect(fixture.client.read).toHaveBeenCalledTimes(2))
    fixture.respond(history.movementPage)
    await fixture.workspace.load(history.movementPage.query)
    delayed.resolve(history.page)
    await loading
    expect(fixture.workspace.getSnapshot()).toMatchObject({ page: history.movementPage, busy: false, error: null })
    expect(fixture.invalidated).not.toHaveBeenCalled()
  })

  it('ignores a late error after filters clear the previous request', async () => {
    const fixture = setup(), delayed = deferred()
    fixture.client.read.mockImplementation(path => path === 'household/session' ? Promise.resolve(fixture.session) : delayed.promise)
    const loading = fixture.workspace.load(history.page.query)
    await vi.waitFor(() => expect(fixture.client.read).toHaveBeenCalledTimes(2))
    fixture.workspace.clear()
    delayed.reject(new PersonalWebError('authentication', 'old account error'))
    await loading
    expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, busy: false, error: null })
    expect(fixture.invalidated).not.toHaveBeenCalled()
  })

  it('does not fetch records when disabled and can recheck availability without enabling it', async () => {
    const fixture = setup()
    fixture.session.capabilities.personalHistory = false
    await fixture.workspace.load(history.page.query)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ available: false, page: null, busy: false, error: null })
    expect(fixture.client.read).toHaveBeenCalledOnce()
    fixture.session.capabilities.personalHistory = true
    fixture.respond(history.emptyPage)
    await fixture.workspace.load(history.emptyPage.query)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ available: true, page: history.emptyPage, error: null })
  })

  it('withdraws previously displayed recordings when access fails and never retries the history automatically', async () => {
    const fixture = setup()
    await fixture.workspace.load(history.page.query)
    fixture.client.read.mockRejectedValueOnce(new PersonalWebError('authentication', 'private peer error'))
    await fixture.workspace.checkAccess()
    expect(fixture.workspace.getSnapshot().page).toBeNull()
    expect(fixture.invalidated).toHaveBeenCalledOnce()
    expect(fixture.client.dispose).toHaveBeenCalledOnce()
    expect(fixture.client.read).toHaveBeenCalledTimes(4)
  })

  it('clears a cached page after a household revision or history capability changes', async () => {
    for (const change of ['revision', 'capability']) {
      const fixture = setup()
      await fixture.workspace.load(history.page.query)
      if (change === 'revision') fixture.session.householdRevision++
      else fixture.session.capabilities.personalHistory = false
      await fixture.workspace.checkAccess()
      expect(fixture.workspace.getSnapshot().page).toBeNull()
      expect(fixture.invalidated).not.toHaveBeenCalled()
    }
  })

  it('disposes in-memory records and suppresses late responses without saving them', async () => {
    const fixture = setup(), delayed = deferred()
    await fixture.workspace.load(history.page.query)
    fixture.client.read.mockImplementation(path => path === 'household/session' ? Promise.resolve(fixture.session) : delayed.promise)
    const loading = fixture.workspace.load(history.page.query)
    await vi.waitFor(() => expect(fixture.client.read).toHaveBeenCalledTimes(5))
    fixture.workspace.dispose()
    delayed.resolve(history.page)
    await loading
    expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, busy: false, error: null })
    expect(fixture.client.dispose).toHaveBeenCalledOnce()
  })

  it('rejects invalid ranges, caller-selected cursors and extra identity selectors before fetching', async () => {
    const fixture = setup()
    for (const query of [{ ...history.page.query, side: 'left' }, { ...history.page.query, cursor: 'not-a-first-page' }, { ...history.page.query, endsAt: 0 }]) {
      await fixture.workspace.load(query)
      expect(fixture.workspace.getSnapshot().page).toBeNull()
    }
    expect(fixture.client.read).not.toHaveBeenCalled()
  })
})

describe('browser calendar history ranges', () => {
  it('includes the whole through date and rejects invalid/reversed/overlong calendar dates', () => {
    const range = historyDateRange('2026-10-01', '2026-10-01')
    expect(historyDateInput(new Date(range.startsAt))).toBe('2026-10-01')
    expect(historyDateInput(new Date(range.endsAt))).toBe('2026-10-02')
    for (const dates of [['2026-02-30', '2026-03-01'], ['', '2026-10-01'], ['2026-10-03', '2026-10-01'], ['2026-01-01', '2026-10-01']])
      expect(() => historyDateRange(dates[0], dates[1])).toThrow()
  })
  it.each([['2026-03-08', 23], ['2026-11-01', 25]])('keeps the %s local-day DST boundary intact', (day, hours) => {
    const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { historyDateRange } from './src/household/web/history.ts'; const range = historyDateRange('${day}', '${day}'); process.stdout.write(String((range.endsAt - range.startsAt) / 3600000))`],
    { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8', timeout: 15000 })
    expect(Number(result)).toBe(hours)
  })
})
