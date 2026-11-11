import { test, expect } from './ownerTest'

test.use({ serviceWorkers: 'block' })
test('bed care requires owner access over REST and tRPC', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/health/care', '/api/trpc/health.care']) expect((await anonymous.get(path)).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const response = await request.get('/api/health/care', { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  const report = await response.json()
  expect(report.apiVersion).toBe(1)
  expect(report.checks).toHaveLength(5)
  expect(report.checks.find((check: { id: string }) => check.id === 'water').state).toBe('unknown')
})
for (const width of [390, 1024]) {
  test(`bed care shows practical recovery and withdraws stale observations at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.clock.install()
    await page.goto('/en/system?tab=care')
    const care = page.getByRole('region', { name: 'Bed care', exact: true })
    await expect(care.getByText('Water & priming', { exact: true })).toBeVisible()
    await expect(care.getByText('No current water reading is available.', { exact: true })).toBeVisible()
    await care.screenshot({ path: testInfo.outputPath(`bed-care-${width}.png`) })
    await expect(care.getByRole('button', { name: /Prime|Restart|Delete|Reset|Dismiss/ })).toHaveCount(0)
    await page.route('**/api/trpc/health.care**', route => route.abort())
    await page.clock.fastForward(35_000)
    await expect(care.getByRole('status')).toContainText('Care checks unavailable')
    await care.getByText('A careful recovery, step by step', { exact: true }).click()
    await expect(care.getByText(/^Before software maintenance, export a backup/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
