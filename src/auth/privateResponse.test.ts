import { describe, expect, it } from 'vitest'
import { privateApiResponse } from './privateResponse'

describe('private API responses', () => {
  it('keeps a streaming error body and adapter headers without caching either identity', async () => {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('private fixture'))
      controller.close()
    } }), { status: 409, headers: { 'Vary': 'Accept, cookie', 'Cache-Control': 'public, max-age=3600', 'Retry-After': '30' } })
    const result = privateApiResponse(response)
    expect(result.status).toBe(409)
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(result.headers.get('Vary')).toBe('Accept, cookie, Authorization')
    expect(result.headers.get('Retry-After')).toBe('30')
    expect(response.bodyUsed).toBe(false)
    expect(await result.text()).toBe('private fixture')
  })
})
