// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_OWNER_TOKEN } from '@/src/auth/tests/support'

vi.mock('@/src/server/routers/app', () => ({ appRouter: {} }))
vi.mock('@trpc/server/adapters/fetch', () => ({ fetchRequestHandler: vi.fn(() => new Response('trpc')) }))
vi.mock('trpc-to-openapi', () => ({ createOpenApiFetchHandler: vi.fn(() => new Response('rest')) }))

import { GET as trpc } from '@/app/api/trpc/[trpc]/route'
import { GET as rootTrpc } from '@/app/api/trpc/route'
import { GET as rest } from '@/app/api/[...rest]/route'

beforeEach(() => {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('API route access without relying on the Next proxy', () => {
  it.each([trpc, rootTrpc, rest])('rejects unauthenticated dispatch', async (handler) => {
    expect((await handler(new Request('http://pod.local/api/device/status'))).status).toBe(401)
  })

  it.each([trpc, rootTrpc, rest])('allows native owner dispatch', async (handler) => {
    expect((await handler(new Request('http://pod.local/api/device/status', {
      headers: { Authorization: `Bearer ${TEST_OWNER_TOKEN}` },
    }))).status).toBe(200)
  })
})
