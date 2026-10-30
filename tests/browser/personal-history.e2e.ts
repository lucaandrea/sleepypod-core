import { test, expect, type Page } from '@playwright/test'
import history from '../../src/household/fixtures/personal-history-v1.json' with { type: 'json' }
import { parsePersonalHistorySearch, personalHistoryPageSchema, type PersonalHistoryPage } from '../../src/household/historyApiContract'
import type { PersonalHistoryQuery } from '../../src/household/historyContract'
import { mockPersonal } from './personal-fixture'

test.use({ timezoneId: 'America/Los_Angeles' })

function examplePage(query: PersonalHistoryQuery): PersonalHistoryPage {
  const fixture = query.kind === 'vitals' ? history.vitalsPage : query.kind === 'movement' ? history.movementPage : history.page
  const range = { startsAt: query.startsAt, endsAt: query.endsAt, kind: query.kind, limit: query.limit }
  const parsed = personalHistoryPageSchema.parse(fixture)
  const record = structuredClone(parsed.records[0])
  record.startsAt = range.startsAt - 3600000
  record.endsAt = range.startsAt + 7 * 3600000
  if (query.kind !== 'presence') {
    record.startsAt = range.startsAt + 6 * 3600000
    record.endsAt = record.startsAt + 60000
  }
  return { ...parsed, generatedAt: Date.now(), query: range, records: [record] }
}

async function mockHistory(page: Page) {
  const personal = await mockPersonal(page)
  personal.session.capabilities.personalHistory = true
  const fixture = { ...personal, requests: [] as PersonalHistoryQuery[], status: 200,
    reply: (query: PersonalHistoryQuery): PersonalHistoryPage => examplePage(query),
    beforeReply: async () => {} }
  await page.route('**/api/v1/me/sleep?*', async (route) => {
    const request = route.request(), query = parsePersonalHistorySearch(new URL(request.url()).searchParams)
    expect(request.method()).toBe('GET')
    expect(request.headers()['x-sleepypod-sleeper-id']).toBe(personal.session.selfSleeperId)
    expect(request.headers().authorization).toBeUndefined()
    fixture.requests.push(query)
    const result = fixture.reply(query)
    // The frozen control fixture uses a different sample sleeper than history.
    // Align synthetic ownership while retaining each contract unchanged.
    result.scope.sleeperId = personal.session.selfSleeperId
    result.records = result.records.map(record => ({ ...record, sleeperId: personal.session.selfSleeperId }))
    await fixture.beforeReply()
    await route.fulfill({ status: fixture.status, json: result })
  })
  return fixture
}

const panel = (page: Page) => page.locator('article[aria-label="Your private recordings"]')
async function openHistory(page: Page) {
  await page.goto('/household/index.html')
  await panel(page).getByLabel('From date').fill('2026-10-29')
  await panel(page).getByLabel('Through date').fill('2026-10-29')
}

test('personal history preserves complete recordings and stays readable on phone and tablet', async ({ page }) => {
  const fixture = await mockHistory(page), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openHistory(page)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page).getByRole('list', { name: 'Private Pod recordings' })).toContainText('7h 0m')
  await expect(panel(page)).toContainText('not confirmed sleep')
  await expect(panel(page)).toContainText('complete recording spans 8h 0m')
  await expect(panel(page)).toContainText('extends outside your chosen dates')
  await expect(panel(page)).toContainText('Pod · recorded Left')
  await expect(panel(page)).toContainText('America/Los_Angeles')
  await page.setViewportSize({ width: 1024, height: 1000 })
  await panel(page).screenshot({ path: test.info().outputPath('history-tablet-light.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await panel(page).screenshot({ path: test.info().outputPath('history-phone-dark-large.png') })
  expect(fixture.posts).toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('recording kinds preserve nulls, zero HRV and short intervals without claiming sleep or stages', async ({ page }) => {
  const fixture = await mockHistory(page)
  fixture.reply = (query) => {
    const result = examplePage(query)
    if (result.records[0].payload.kind === 'vitals') result.records[0].payload.hrvMs = 0
    if (result.records[0].payload.kind === 'presence') {
      result.records[0].startsAt = query.startsAt
      result.records[0].endsAt = query.startsAt + 30000
      result.records[0].payload.reportedPresenceSeconds = 30
    }
    return result
  }
  await openHistory(page)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page).locator('.history-value')).toHaveText('30s')
  await expect(panel(page).locator('.history-interval')).toContainText('12:00:30 AM')
  await panel(page).getByLabel('Recording type').selectOption('vitals')
  await expect(panel(page).locator('.history-list')).toHaveCount(0)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page).locator('.history-metrics')).toContainText('61 bpm')
  await expect(panel(page).locator('.history-metrics')).toContainText('Unavailable')
  await expect(panel(page).locator('.history-metrics')).toContainText('0 ms')
  await expect(panel(page)).toContainText('differs from Apple Watch HRV')
  await expect(panel(page)).toContainText('Signal quality is not supplied')
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768)
  await panel(page).screenshot({ path: test.info().outputPath('history-vitals-tablet-large.png') })
  await panel(page).getByLabel('Recording type').selectOption('movement')
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page)).toContainText('Recorded movement total · not a sleep stage')
  await expect(panel(page).locator('.history-value')).toHaveText('42')
  expect(fixture.posts).toEqual([])
  expect(fixture.unexpected).toEqual([])
})

test('history pagination replaces the page, keeps cursor bytes and clears an expired snapshot', async ({ page }) => {
  const fixture = await mockHistory(page)
  fixture.reply = (query) => {
    const result = examplePage(query)
    if (query.cursor) {
      expect(query.cursor).toBe('opaque+cursor/with=padding')
      result.records[0].id = '10000000-0000-4000-8000-000000000099'
      result.records[0].startsAt -= 30000
      return result
    }
    return { ...result, nextCursor: 'opaque+cursor/with=padding', records: Array.from({ length: query.limit }, (_, index) => ({
      ...structuredClone(result.records[0]), id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, startsAt: result.records[0].startsAt - index * 1000,
    })) }
  }
  await openHistory(page)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page).locator('.history-record')).toHaveCount(30)
  await panel(page).getByRole('button', { name: 'Show older recordings' }).click()
  await expect(panel(page).locator('.history-record')).toHaveCount(1)
  await expect(panel(page)).toContainText('Page 2')
  await panel(page).getByRole('button', { name: 'Reload latest recordings' }).click()
  await expect(panel(page).locator('.history-record')).toHaveCount(30)
  expect(fixture.requests.at(-1)?.cursor).toBeUndefined()
  fixture.status = 409
  await panel(page).getByRole('button', { name: 'Show older recordings' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('changed')
  await expect(panel(page).locator('.history-record')).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: 'Show older recordings' })).toHaveCount(0)
  expect(fixture.posts).toEqual([])
})

test('empty, unavailable and failed history states remain explicit and allow a fresh read', async ({ page }) => {
  const fixture = await mockHistory(page)
  fixture.session.capabilities.personalHistory = false
  await openHistory(page)
  await panel(page).getByRole('button', { name: 'Check history availability' }).click()
  await expect(panel(page)).toContainText('Personal history is not enabled')
  await expect(panel(page).getByRole('alert')).toHaveCount(0)
  expect(fixture.requests).toHaveLength(0)
  fixture.session.capabilities.personalHistory = true
  fixture.reply = query => ({ ...examplePage(query), records: [] })
  await panel(page).getByRole('button', { name: 'Check history availability' }).click()
  await expect(panel(page)).toContainText('No attributed recordings for these dates')
  await expect(panel(page)).toContainText('does not mean you slept zero hours')
  fixture.status = 500
  await panel(page).getByRole('button', { name: 'Reload latest recordings' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('could not be verified')
  fixture.status = 200
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page)).toContainText('No attributed recordings for these dates')
  await panel(page).getByLabel('From date').fill('2026-01-01')
  await expect(panel(page).locator('.history-empty')).toHaveCount(0)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('shorter period')
  expect(fixture.requests).toHaveLength(3)
  expect(fixture.posts).toEqual([])
})

test('a slow history request leaves Stop independent and clears records when the account changes', async ({ page }) => {
  const fixture = await mockHistory(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => release = resolve)
  fixture.beforeReply = () => pending
  await openHistory(page)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect.poll(() => fixture.requests.length).toBe(1)
  try {
    await expect(panel(page).getByRole('button', { name: 'Reading your history…' })).toBeDisabled()
    await page.getByRole('button', { name: 'Stop temperature', exact: true }).click()
    await expect.poll(() => fixture.posts.length).toBe(1)
    expect(fixture.posts[0].body.action).toEqual({ kind: 'power', powered: false })
    fixture.session.sessionRevision++
  }
  finally { release() }
  await expect(page.locator('#message')).toContainText('account or assignment changed')
  await expect(panel(page)).toHaveCount(0)
  expect(fixture.unexpected).toEqual([])
})

test('hidden-tab and reload lifecycle discard private records rather than restore cached history', async ({ page }) => {
  const fixture = await mockHistory(page)
  await openHistory(page)
  await panel(page).getByRole('button', { name: 'View my recordings' }).click()
  await expect(panel(page).locator('.history-record')).toHaveCount(1)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(panel(page).locator('.history-record')).toHaveCount(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(fixture.requests).toHaveLength(1)
  await page.reload()
  await expect(panel(page).getByRole('button', { name: 'View my recordings' })).toBeVisible()
  await expect(panel(page).locator('.history-record')).toHaveCount(0)
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.posts).toEqual([])
})
