/** Preserve streaming bodies and adapter headers while preventing private API caching. */
export function privateApiResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  const vary = (headers.get('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  for (const identity of ['Authorization', 'Cookie']) {
    if (!vary.some(value => value.toLowerCase() === identity.toLowerCase())) vary.push(identity)
  }
  headers.set('Vary', vary.join(', '))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
