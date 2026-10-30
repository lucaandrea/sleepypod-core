import type { Page } from '@playwright/test'
import preparation from '../../src/household/fixtures/preparation-v1.json' with { type: 'json' }
import controls from '../../src/household/fixtures/personal-controls-v1.json' with { type: 'json' }
import routines from '../../src/household/fixtures/personal-routines-v1.json' with { type: 'json' }

// These UI scenarios intercept every API request. The real server's hardware
// flags remain off; household.e2e covers its real disabled-runtime boundaries.
export async function mockPersonal(page: Page, loseFirstControl = false) {
  const session = { ...structuredClone(preparation.ownerSession), selfSleeperId: controls.soloBed.scope.sleeperId,
    capabilities: { ...preparation.ownerSession.capabilities, personalControls: true, personalRoutinePublication: true } }
  const review = structuredClone(routines.readyReview)
  let drafts = { ...preparation.routines, sleeperId: session.selfSleeperId, revision: 2, routines: structuredClone(review.draftWeek) }
  const receipts = new Map<string, unknown>()
  const posts: Array<{ path: string, body: Record<string, unknown> }> = []
  const unexpected: string[] = []
  let lost = false
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    const body = request.method() === 'GET' ? undefined : request.postDataJSON()
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/api/v1/household/session' && request.method() === 'GET') return json(session)
    if (path === '/api/v1/me/preferences') return json({ ...preparation.preferences, sleeperId: session.selfSleeperId, preferences: { ...preparation.preferences.preferences, preferredTemperatureF: 70 } })
    if (path === '/api/v1/household/devices') return json(preparation.devices)
    if (path === '/api/v1/household/invitations') return json({ invitations: [] })
    if (path === '/api/v1/me/bed') return json({ ...controls.soloBed, observation: { ...controls.soloBed.observation, observedAt: Date.now() } })
    if (path === '/api/v1/me/routines' && request.method() === 'GET') return json(drafts)
    if (path === '/api/v1/me/routines' && request.method() === 'PUT') {
      posts.push({ path, body })
      drafts = { ...drafts, revision: drafts.revision + 1, routines: body.routines }
      review.draftWeek = body.routines
      review.draftRevision = drafts.revision
      return json(drafts)
    }
    if (path === '/api/v1/me/routines/review') return json(review)
    if (path === '/api/v1/me/controls') {
      posts.push({ path, body })
      const receipt = { ...controls.acknowledged, ...body, receivedAt: Date.now(), finishedAt: Date.now(), lastDispatchAt: Date.now() }
      receipts.set(body.requestId, receipt)
      if (loseFirstControl && !lost) {
        lost = true
        return route.abort('failed')
      }
      return json(receipt)
    }
    if (path === '/api/v1/me/routines/publish') {
      posts.push({ path, body })
      const receipt = { ...routines.saved, requestId: body.requestId, draftRevision: drafts.revision, publishedWeek: drafts.routines.map(night => ({ ...night, revision: 'f'.repeat(64) })) }
      receipts.set(body.requestId, receipt)
      return json(receipt)
    }
    const receipt = receipts.get(path.split('/').at(-1) ?? '')
    if (receipt && request.method() === 'GET') return json(receipt)
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { error: 'unmocked route' } })
  })
  return { session, review, posts, unexpected }
}

