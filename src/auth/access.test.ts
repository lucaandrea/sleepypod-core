// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authorized, issueSession, requireAccess, SESSION_COOKIE, SESSION_SECONDS } from './access'
import { DELETE, GET, POST } from '../../app/api/auth/session/route'

const token = 'test-only-owner-key-with-over-thirty-two-characters'
const origin = 'http://pod.local:3000'
const now = 1_790_000_000_000

function browserHeaders(session = issueSession(), source = origin) {
  return new Headers({ host: 'pod.local:3000', origin: source, cookie: `${SESSION_COOKIE}=${session}` })
}

beforeEach(() => {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', token)
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('controller access', () => {
  it('fails closed when missing configuration or credentials', () => {
    expect(requireAccess(new Request(origin))?.status).toBe(401)
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
    expect(requireAccess(new Request(origin))?.status).toBe(503)
    expect(() => issueSession()).toThrow()
  })

  it('accepts native bearer credentials and rejects query-string tokens', () => {
    expect(requireAccess(new Request(origin, { headers: { authorization: `Bearer ${token}` } }))).toBeNull()
    expect(requireAccess(new Request(`${origin}/?token=${token}`))?.status).toBe(401)
    expect(authorized(new Headers({ authorization: `Bearer ${token}wrong` }))).toBe(false)
  })

  it('requires same-origin cookies for writes and same-host cookies for streams', () => {
    expect(authorized(browserHeaders(), 'POST')).toBe(true)
    expect(authorized(browserHeaders(undefined, 'http://10.0.1.99:3000'), 'POST')).toBe(false)
    const headers = browserHeaders()
    headers.delete('origin')
    expect(authorized(headers)).toBe(true)
    expect(authorized(headers, 'POST')).toBe(false)
    expect(authorized(headers, 'GET', true)).toBe(false)
    headers.set('origin', origin)
    headers.set('host', 'pod.local:3001')
    expect(authorized(headers, 'GET', true)).toBe(true)
    headers.set('origin', 'http://attacker.local:3000')
    expect(authorized(headers, 'GET', true)).toBe(false)
  })

  it('rejects tampering, duplicate cookies, expiry and credentials after rotation', () => {
    const session = issueSession()
    expect(authorized(browserHeaders(session))).toBe(true)
    expect(authorized(browserHeaders(session + 'x'))).toBe(false)
    const duplicate = browserHeaders(session)
    duplicate.append('cookie', `${SESSION_COOKIE}=${session}`)
    expect(authorized(duplicate)).toBe(false)
    vi.setSystemTime(now + SESSION_SECONDS * 1000)
    expect(authorized(browserHeaders(session))).toBe(false)
    vi.setSystemTime(now)
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', token + '-rotated')
    expect(authorized(browserHeaders(session))).toBe(false)
  })
})

describe('browser session endpoint', () => {
  function login(body: string, source = origin) {
    return POST(new Request(`${origin}/api/auth/session`, {
      method: 'POST', headers: { 'host': 'pod.local:3000', 'origin': source, 'content-type': 'application/json' }, body,
    }))
  }

  it('issues an HttpOnly session without echoing the key', async () => {
    const response = await login(JSON.stringify({ token }))
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly; SameSite=Strict')
    expect(cookie).not.toContain(token)
    const request = new Request(origin, { headers: { host: 'pod.local:3000', cookie } })
    expect(await GET(request).json()).toMatchObject({ authenticated: true })
    expect(DELETE(new Request(origin, { method: 'DELETE', headers: browserHeaders() })).headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('rejects invalid tokens, malformed or oversized bodies and cross-site login', async () => {
    expect((await login(JSON.stringify({ token: 'wrong' }))).status).toBe(401)
    expect((await login('{')).status).toBe(400)
    expect((await login('x'.repeat(9000))).status).toBe(413)
    expect((await login(JSON.stringify({ token }), 'https://attacker.example')).status).toBe(403)
  })
})
