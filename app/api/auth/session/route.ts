import { authConfigured, authorized, issueSession, sameOrigin, SESSION_COOKIE, SESSION_SECONDS, validOwnerToken } from '@/src/auth/access'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return Response.json({ configured: authConfigured(), authenticated: authorized(request.headers) }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: Request) {
  if (!sameOrigin(request.headers)) return Response.json({ error: 'Same-origin connection required' }, { status: 403 })
  if (!authConfigured()) return Response.json({ error: 'Configure SLEEPYPOD_AUTH_TOKEN on the controller first' }, { status: 503 })
  if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415 })
  // Stream a bounded login body; an absent Content-Length must not allow unlimited buffering.
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400 })
  let body = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        body += decoder.decode()
        break
      }
      body += decoder.decode(chunk.value, { stream: true })
      if (body.length > 8192) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
    }
    const value = JSON.parse(body) as { token?: unknown }
    if (!validOwnerToken(value?.token)) return Response.json({ error: 'Invalid connection key' }, { status: 401 })
  }
  catch { return new Response(null, { status: 400 }) }
  return Response.json({ authenticated: true }, {
    headers: { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, issueSession(), SESSION_SECONDS) },
  })
}

export function DELETE(request: Request) {
  if (!sameOrigin(request.headers)) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie(request, '', 0), 'Cache-Control': 'no-store' } })
}

function sessionCookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' || process.env.SLEEPYPOD_HTTPS_ONLY === '1'
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}
