'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

/** Keep device queries and streaming components unmounted until the owner has connected. */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'connected' | 'locked' | 'unconfigured'>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const demo = process.env.NEXT_PUBLIC_DEMO === '1'

  useEffect(() => {
    if (demo) return
    let alive = true
    const refresh = async () => {
      try {
        const response = await fetch('/api/auth/session', { cache: 'no-store' })
        if (!response.ok) throw new Error('Controller unavailable')
        const result = await response.json() as { configured: boolean, authenticated: boolean }
        if (alive) setState(result.authenticated ? 'connected' : result.configured ? 'locked' : 'unconfigured')
      }
      catch {
        if (alive) {
          setState('locked')
          setError('Could not reach the controller. Check your connection.')
        }
      }
    }
    void refresh()
    const interval = setInterval(() => refresh(), 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [demo])

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      })
      if (!response.ok) throw new Error(response.status === 401 ? 'That connection key was not accepted.' : 'Could not connect to the controller.')
      setToken('')
      setState('connected')
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Connection failed.') }
    finally { setBusy(false) }
  }

  if (demo || state === 'connected') return children
  return (
    <main className="grid min-h-dvh place-items-center bg-app px-6 text-fg">
      <form onSubmit={connect} className="flex w-full max-w-sm flex-col gap-5 rounded-card border border-line bg-surface p-7">
        <p className="text-xs font-medium uppercase tracking-widest text-cool">Sleep · Home · You</p>
        <h1 className="text-3xl font-medium">Your night, connected.</h1>
        {state === 'checking'
          ? <p role="status" className="text-fg-2">Checking your connection…</p>
          : state === 'unconfigured'
            ? <p className="text-fg-2">This controller needs an owner connection key. Complete controller setup before connecting.</p>
            : (
                <>
                  <p className="text-fg-2">Enter your Pod connection key. Your browser keeps a private, temporary session.</p>
                  <label className="flex flex-col gap-2">
                    Connection key
                    <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="current-password" spellCheck={false} required minLength={32} maxLength={4096} className="min-h-12 rounded-ctl border border-line-2 bg-field px-3" />
                  </label>
                  <button disabled={busy} className="min-h-12 rounded-ctl bg-cool px-5 font-medium text-inverse disabled:opacity-60">{busy ? 'Connecting…' : 'Connect to your Pod'}</button>
                </>
              )}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </form>
    </main>
  )
}
