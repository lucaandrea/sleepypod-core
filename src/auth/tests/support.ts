import { vi } from 'vitest'

export const TEST_OWNER_TOKEN = 'test-only-sleepypod-owner-key-not-for-production'

export function ownerRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${TEST_OWNER_TOKEN}`)
  return new Request(input, { ...init, headers })
}
