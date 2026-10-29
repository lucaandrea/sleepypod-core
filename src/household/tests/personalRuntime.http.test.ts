import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { beforeControlWrite } from '@/src/controls/context'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { personalRuntimeFixture } from './runtimeFixture'
import { personalControlReceiptSchema } from '../controlContract'
import { personalBedSchema } from '../bedContract'

let fixture: ReturnType<typeof personalRuntimeFixture>, dependencies: HouseholdHttpDependencies, directory: string, legacyKey: string
function request(path: string, method = 'GET', body?: unknown, key?: string, headers: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/${path}`, { method,
    headers: { host: 'pod.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function browserHeaders() {
  const token = issuePersonalSession(fixture.identities.deviceIdentity(fixture.ownerKey))
  const scopeCookie = bindBrowserScope(request('me/bed'), 'personal', token).split(';')[0]
  const cookie = `${PERSONAL_COOKIE}=${token}; ${scopeCookie}`
  return { cookie, 'origin': 'http://pod.test', 'x-sleepypod-sleeper-id': fixture.owner.selfSleeperId,
    'x-sleepypod-browser-revision': browserScopeRevision(new Headers({ cookie })) ?? '' }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-personal-runtime-'))
  const databasePath = join(directory, 'configuration.db')
  fixture = personalRuntimeFixture(databasePath)
  legacyKey = randomBytes(32).toString('base64url')
  vi.stubEnv('DATABASE_URL', databasePath)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', legacyKey)
  dependencies = { store: fixture.identities, personalRuntime: fixture.runtime, verifySoloConfiguration: () => true }
})
afterEach(() => {
  fixture.database.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('personal bed and control HTTP boundary', () => {
  it('requires a personal credential and returns only the assigned bed data with private caching headers', async () => {
    fixture.assignedFixture()
    for (const key of [undefined, legacyKey]) {
      expect((await householdHttp(request('me/bed', 'GET', undefined, key), dependencies)).status).toBe(401)
    }
    const response = await householdHttp(request('me/bed', 'GET', undefined, fixture.memberKey), dependencies)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Authorization, Cookie')
    const bed = personalBedSchema.parse(await response.json())
    expect(bed.scope.sleeperId).toBe(fixture.member.selfSleeperId)
    expect(bed.zones).toEqual([{ side: 'left', measuredTemperatureF: 69, reportedTargetF: 70, reportedPowered: true, requestedTargetF: 68 }])
  })

  it('advertises controls only when enabled and assigned; draft-only preferences do not change the hardware', async () => {
    for (const [key, enabled] of [[fixture.ownerKey, true], [fixture.memberKey, false]] as const) {
      const response = await householdHttp(request('household/session', 'GET', undefined, key), dependencies)
      expect((await response.json()).capabilities.personalControls).toBe(enabled)
    }
    fixture.clock.enabled = false
    const response = await householdHttp(request('me/bed', 'GET', undefined, fixture.ownerKey), dependencies)
    expect(await response.json()).toMatchObject({ availability: 'runtime_disabled', zones: [] })
    expect((await householdHttp(request('me/controls', 'POST', fixture.command(), fixture.ownerKey), dependencies)).status).toBe(409)
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('returns an own durable receipt, reconciles retries and hides it from another account', async () => {
    const input = fixture.command()
    const first = await householdHttp(request('me/controls', 'POST', input, fixture.ownerKey), dependencies)
    expect(first.status).toBe(200)
    const receipt = personalControlReceiptSchema.parse(await first.json())
    expect(receipt).toMatchObject({ state: 'acknowledged', resolvedZones: ['left', 'right'], dispatchCount: 2, replayAllowed: false, physicalVerification: 'unverified' })
    const retry = await householdHttp(request('me/controls', 'POST', input, fixture.ownerKey), dependencies)
    const lookup = await householdHttp(request(`me/controls/${input.requestId}`, 'GET', undefined, fixture.ownerKey), dependencies)
    expect(await retry.json()).toEqual(receipt)
    expect(await lookup.json()).toEqual(receipt)
    const foreign = await householdHttp(request(`me/controls/${input.requestId}`, 'GET', undefined, fixture.memberKey), dependencies)
    const missing = await householdHttp(request(`me/controls/${randomUUID()}`, 'GET', undefined, fixture.memberKey), dependencies)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(fixture.execute).toHaveBeenCalledTimes(2)
  })

  it('rejects changed retries, caller-selected zones, unknown actions and invalid receipt IDs', async () => {
    const input = fixture.command()
    await householdHttp(request('me/controls', 'POST', input, fixture.ownerKey), dependencies)
    const changed = { ...input, action: { kind: 'power', powered: false } }
    expect((await householdHttp(request('me/controls', 'POST', changed, fixture.ownerKey), dependencies)).status).toBe(409)
    for (const action of [{ ...input.action, side: 'right' }, { kind: 'vibration', intensity: 100 }, { kind: 'base.position', head: 50, feet: 40 }]) {
      expect((await householdHttp(request('me/controls', 'POST', { ...input, requestId: randomUUID(), action }, fixture.ownerKey), dependencies)).status).toBe(400)
    }
    expect((await householdHttp(request('me/controls/not-a-request-id', 'GET', undefined, fixture.ownerKey), dependencies)).status).toBe(400)
    expect(fixture.execute).toHaveBeenCalledTimes(2)
  })

  it('requires both same-origin and the selected sleeper on browser mutations', async () => {
    const headers = browserHeaders(), input = fixture.command()
    const withoutOrigin = { 'cookie': headers.cookie, 'x-sleepypod-sleeper-id': headers['x-sleepypod-sleeper-id'] }
    const withoutSleeper = { cookie: headers.cookie, origin: headers.origin }
    expect((await householdHttp(request('me/controls', 'POST', input, undefined, withoutOrigin), dependencies)).status).toBe(403)
    expect((await householdHttp(request('me/controls', 'POST', input, undefined, withoutSleeper), dependencies)).status).toBe(409)
    expect((await householdHttp(request('me/controls', 'POST', input, undefined, { ...headers, origin: 'https://foreign.test' }), dependencies)).status).toBe(403)
    expect(fixture.execute).not.toHaveBeenCalled()
    expect((await householdHttp(request('me/controls', 'POST', input, undefined, headers), dependencies)).status).toBe(200)
  })

  it('does not expose a reading when the browser logs out during the hardware wait', async () => {
    const incoming = request('me/bed', 'GET', undefined, undefined, browserHeaders())
    fixture.observe.mockImplementationOnce(async () => {
      bindBrowserScope(incoming, 'signed_out', '')
      return fixture.observation
    })
    const response = await householdHttp(incoming, dependencies)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('measuredTemperatureF')
    expect(fixture.requestedTarget).not.toHaveBeenCalled()
  })

  it('checks browser identity again at dispatch and withholds a private receipt after account switch', async () => {
    const input = fixture.command(), headers = browserHeaders()
    const incoming = request('me/controls', 'POST', input, undefined, headers)
    fixture.execute.mockImplementationOnce(async () => {
      beforeControlWrite()
      const partnerToken = issuePersonalSession(fixture.identities.deviceIdentity(fixture.memberKey))
      bindBrowserScope(incoming, 'personal', partnerToken)
    })
    const response = await householdHttp(incoming, dependencies)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('resolvedZones')
    const receipt = await householdHttp(request(`me/controls/${input.requestId}`, 'GET', undefined, fixture.ownerKey), dependencies)
    expect(await receipt.json()).toMatchObject({ state: 'unknown', dispatchCount: 1 })
    expect(fixture.execute).toHaveBeenCalledTimes(1)
  })

  it('does not claim that nothing was sent when the completion receipt cannot be saved', async () => {
    fixture.database.exec('CREATE TRIGGER fail_completion BEFORE UPDATE OF state ON household_control_receipts WHEN NEW.state != \'executing\' BEGIN SELECT RAISE(ABORT, \'private-storage-failure\'); END;')
    const response = await householdHttp(request('me/controls', 'POST', fixture.command(), fixture.ownerKey), dependencies)
    expect(response.status).toBe(503)
    expect(fixture.execute).toHaveBeenCalledTimes(2)
    const message = await response.text()
    expect(message).not.toContain('No hardware command was sent')
    expect(message).not.toContain('private-storage-failure')
    expect(message).toContain('could not be confirmed')
  })
})
