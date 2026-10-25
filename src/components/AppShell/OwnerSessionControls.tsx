'use client'

import { useState } from 'react'

export function OwnerSessionControls() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (process.env.NEXT_PUBLIC_DEMO === '1') return null

  async function disconnect() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/session', { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not end this browser session. Try again.')
      // A full reload discards private query caches and closes live subscriptions.
      window.location.reload()
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not disconnect.')
      setBusy(false)
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-6">
      <h2 className="text-lg font-medium">Browser connection</h2>
      <p className="mt-2 text-sm text-fg-2">End this browser session. Your Pod continues its local routines.</p>
      <button type="button" disabled={busy} onClick={disconnect} className="mt-4 min-h-11 rounded-ctl border border-line px-4 disabled:opacity-60">
        {busy ? 'Disconnecting…' : 'Disconnect this browser'}
      </button>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  )
}
