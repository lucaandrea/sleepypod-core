import { test, expect } from '@playwright/test'

test('sensor Preview persists consent, shows missing evidence and cannot activate hardware', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.get('/api/v1/comfort?side=left')).status()).toBe(401)
  expect((await anonymous.post('/api/v1/comfort/configure', { data: { side: 'left', config: { mode: 'preview', minimumF: 70, maximumF: 95, sensorAware: true } } })).status()).toBe(401)
  await anonymous.dispose()

  await page.goto('/en/autopilot')
  const guard = page.getByRole('checkbox', { name: /Use Pod sensor guard in Preview/ })
  // The controlled checkbox reflects the persisted response, not an optimistic click.
  await guard.click()
  await expect(guard).toBeChecked()
  await page.getByRole('button', { name: 'Start Preview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop Preview', exact: true })).toBeVisible()
  await page.reload()
  await expect(guard).toBeChecked()
  await expect(page.getByRole('button', { name: 'Stop Preview', exact: true })).toBeVisible()
  // CI never starts hardware or invents a completed personal baseline.
  const baseline = page.getByLabel('Personal Pod baseline')
  await expect(baseline).toContainText('Waiting for evaluation')
  await expect(baseline).toContainText('Unavailable')
  await expect(baseline).toContainText('Incomplete')
  await expect(page.getByText('The Preview service is stopped.')).toBeVisible()
  const saved = await (await request.get('/api/v1/comfort?side=left', { headers })).json()
  expect(saved).toMatchObject({ activation: { available: false }, features: { sensorAware: true },
    state: { config: { mode: 'preview', sensorAware: true }, lastAppliedAt: 0, lastTargetF: null }, signals: null })
  const active = await request.post('/api/v1/comfort/configure', { headers, data: {
    side: 'left', config: { mode: 'active', minimumF: 70, maximumF: 95, sensorAware: true },
  } })
  expect(active.status()).toBe(412)

  await baseline.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('comfort-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await baseline.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('comfort-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Stop Preview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start Preview', exact: true })).toBeVisible()
  expect(await (await request.get('/api/v1/comfort?side=left', { headers })).json()).toMatchObject({ state: { config: { mode: 'off', sensorAware: true } } })
})
