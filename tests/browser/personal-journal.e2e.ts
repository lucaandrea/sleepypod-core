import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { mockPersonal } from './personal-fixture'
import { personalJournalWriteSchema, type PersonalJournalReceipt, type PersonalJournalSelection } from '../../src/household/personalJournalContract'
import { sourceDate } from '../../src/lib/localDates'

/** Synthetic personal records; every request is intercepted before it reaches the fixture server. */
async function mockJournal(page: Page) {
  const personal = await mockPersonal(page)
  Object.assign(personal.session.capabilities, { personalJournal: true })
  const now = Date.now(), zone = 'America/Los_Angeles', today = sourceDate(now / 1000, zone)
  const entries = new Map<string, PersonalJournalSelection>(), receipts = new Map<string, PersonalJournalReceipt>()
  const writes: unknown[] = []
  const fixture = { ...personal, today, entries, receipts, writes, loseReply: false, failRead: false, delayRead: async () => {} }
  const envelope = () => ({ version: 1, generatedAt: Date.now(), interpretation: 'personal_self_report_not_sleep_measurement',
    scope: { podId: personal.session.podId, householdId: personal.session.householdId, accountId: personal.session.accountId,
      sleeperId: personal.session.selfSleeperId, sessionRevision: personal.session.sessionRevision,
      assignmentRevision: personal.session.assignmentRevision, householdRevision: personal.session.householdRevision } })
  await page.route('**/api/v1/me/journal**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    expect(request.headers()['x-sleepypod-sleeper-id']).toBe(personal.session.selfSleeperId)
    expect(request.headers().authorization).toBeUndefined()
    if (request.method() === 'POST') {
      const input = personalJournalWriteSchema.parse(request.postDataJSON())
      writes.push(input)
      const current = entries.get(input.date)
      if ((current?.revision ?? null) !== input.expectedRevision) return route.fulfill({ status: 409, json: { error: 'entry_changed' } })
      const receipt: PersonalJournalReceipt = { requestId: input.requestId, date: input.date, revision: randomUUID(), timeZone: zone,
        savedAt: Date.now(), outcome: input.fields ? 'saved' : 'deleted' }
      receipts.set(input.requestId, receipt)
      entries.set(input.date, { date: input.date, revision: receipt.revision, timeZone: zone, record: input.fields
        ? { date: input.date, timeZone: zone, createdAt: receipt.savedAt, updatedAt: receipt.savedAt, fields: input.fields }
        : null })
      if (fixture.loseReply) return route.abort('failed')
      return route.fulfill({ json: { ...envelope(), receipt } })
    }
    await fixture.delayRead()
    if (fixture.failRead) return route.fulfill({ status: 503, json: { error: 'private error must not be displayed' } })
    if (url.pathname.includes('/requests/')) return route.fulfill({ json: { ...envelope(), receipt: receipts.get(url.pathname.split('/').at(-1) ?? '') ?? null } })
    const date = url.searchParams.get('date') ?? ''
    return route.fulfill({ json: { ...envelope(), currentTimeZone: zone, query: { date },
      entries: [entries.get(date) ?? { date, revision: null, timeZone: null, record: null }] } })
  })
  return fixture
}
const panel = (page: Page) => page.getByRole('article', { name: 'Your morning check-in' })
async function open(page: Page) {
  await page.goto('/household/index.html')
  await panel(page).getByRole('button', { name: 'Open my check-in' }).click()
  await expect(panel(page).getByLabel('How rested did you feel?')).toBeVisible()
}
async function edit(page: Page) {
  await panel(page).getByLabel('How rested did you feel?').selectOption('4')
  await panel(page).getByLabel('Bed temperature comfort').selectOption('comfortable')
  await panel(page).getByLabel('Anything to remember?').fill('Felt comfortable after an earlier bedtime.')
}

/** Capture the complete long workspace as ordered viewports instead of one unreliable tall bitmap. */
async function captureWorkspace(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0))
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Workspace capture requires an explicit viewport')
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const tiles: { file: string, top: number, bottom: number }[] = []
  const count = Math.ceil(height / viewport.height)
  expect(count, 'A growing or unbounded document cannot provide a complete capture').toBeLessThanOrEqual(80)
  for (let index = 0; index < count; index++) {
    const top = Math.min(index * viewport.height, Math.max(0, height - viewport.height))
    await page.evaluate(position => window.scrollTo(0, position), top)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(top)
    const file = `${name}-${String(index + 1).padStart(2, '0')}.png`
    await page.screenshot({ path: test.info().outputPath(file) })
    tiles.push({ file, top, bottom: Math.min(height, top + viewport.height) })
  }
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height)
  await writeFile(test.info().outputPath(`${name}.json`), JSON.stringify({ viewport, height, tiles }, null, 2))
  await page.evaluate(() => window.scrollTo(0, 0))
}

test('personal check-in saves, reads and deletes explicit ratings and habit context across phone and tablet', async ({ page }) => {
  const fixture = await mockJournal(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await open(page)
  await expect(panel(page).getByRole('button', { name: 'Save my check-in' })).toBeDisabled()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await panel(page).screenshot({ path: test.info().outputPath('journal-desktop-empty.png') })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: test.info().outputPath('journal-desktop-full.png'), fullPage: true })
  await edit(page)
  await panel(page).getByText('Add habits and timing', { exact: false }).click()
  await panel(page).getByLabel('Caffeine status').selectOption('none')
  await panel(page).getByLabel('Exercise status').selectOption('yes')
  await panel(page).getByLabel('Total exercise (minutes)').fill('30')
  await panel(page).getByText('Bedtime, meal and stress context', { exact: true }).click()
  await panel(page).getByLabel('Stress compared with your usual day').selectOption('usual')
  await page.setViewportSize({ width: 1024, height: 1100 })
  await panel(page).screenshot({ path: test.info().outputPath('journal-tablet-context.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.evaluate(() => window.scrollTo(0, 0))
  await captureWorkspace(page, 'journal-phone-workspace')
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await panel(page).screenshot({ path: test.info().outputPath('journal-phone-dark-large.png') })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: test.info().outputPath('journal-phone-context-large.png') })
  await panel(page).getByRole('button', { name: 'Save my check-in' }).click()
  await expect(panel(page).getByRole('status')).toContainText('saved privately')
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.entries.get(fixture.today)?.record?.fields.context).toMatchObject({ caffeine: { status: 'none' },
    alcohol: { status: 'not_logged' }, exercise: { status: 'yes', amount: 30 } })
  await panel(page).screenshot({ path: test.info().outputPath('journal-phone-saved.png') })
  await panel(page).getByLabel('How rested did you feel?').selectOption('5')
  await expect(panel(page)).toContainText('Unsaved changes to your check-in')
  await expect(panel(page)).not.toContainText('Your saved check-in')
  expect(fixture.entries.get(fixture.today)?.record?.fields.restfulness).toBe(4)
  expect(fixture.writes).toHaveLength(1)
  await panel(page).screenshot({ path: test.info().outputPath('journal-phone-edited-saved.png') })
  await panel(page).getByRole('button', { name: 'Remove this check-in…' }).click()
  await panel(page).screenshot({ path: test.info().outputPath('journal-phone-delete-review.png') })
  await panel(page).getByRole('button', { name: 'Keep check-in' }).click()
  expect(fixture.writes).toHaveLength(1)
  await panel(page).getByRole('button', { name: 'Remove this check-in…' }).click()
  await panel(page).getByRole('button', { name: 'Delete check-in', exact: true }).click()
  await expect(panel(page).getByRole('status')).toContainText('Check-in removed')
  await expect(panel(page).getByLabel('Anything to remember?')).toHaveValue('')
  expect(fixture.writes).toHaveLength(2)
  expect(fixture.posts).toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('a lost response reconciles without a second save and leaves Stop available', async ({ page }) => {
  const fixture = await mockJournal(page)
  await open(page)
  await edit(page)
  fixture.loseReply = true
  await panel(page).getByRole('button', { name: 'Save my check-in' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('not confirmed')
  await expect(panel(page).getByRole('button', { name: 'Save my check-in' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop temperature', exact: true })).toBeEnabled()
  await panel(page).screenshot({ path: test.info().outputPath('journal-uncertain.png') })
  await panel(page).getByRole('button', { name: 'Check saved result' }).click()
  await expect(panel(page).getByRole('status')).toContainText('saved privately')
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.posts).toEqual([])
})

test('closing an unsaved draft requires an explicit discard and hiding clears private text', async ({ page }) => {
  const fixture = await mockJournal(page)
  await open(page)
  await edit(page)
  await panel(page).getByRole('button', { name: 'Close check-in' }).click()
  await expect(panel(page).getByRole('region', { name: 'Review unsaved check-in' })).toBeVisible()
  await panel(page).screenshot({ path: test.info().outputPath('journal-unsaved.png') })
  await panel(page).getByRole('button', { name: 'Keep this draft' }).click()
  await expect(panel(page).getByLabel('Anything to remember?')).toHaveValue('Felt comfortable after an earlier bedtime.')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(panel(page).getByLabel('Anything to remember?')).toHaveCount(0)
  expect(fixture.writes).toEqual([])
})

test('failed and disabled reads have usable recovery without inventing a saved check-in', async ({ page }) => {
  const fixture = await mockJournal(page)
  fixture.failRead = true
  await page.goto('/household/index.html')
  await panel(page).getByRole('button', { name: 'Open my check-in' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('could not be verified')
  await expect(panel(page)).not.toContainText('private error')
  await panel(page).screenshot({ path: test.info().outputPath('journal-read-error.png') })
  fixture.failRead = false
  Object.assign(fixture.session.capabilities, { personalJournal: false })
  await panel(page).getByRole('button', { name: 'Open my check-in' }).click()
  await expect(panel(page)).toContainText('not enabled on this Pod yet')
  expect(fixture.writes).toEqual([])
})
