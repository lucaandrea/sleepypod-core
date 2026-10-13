import Database from 'better-sqlite3'
import { lstatSync } from 'node:fs'
import { z } from 'zod'

/** Trusted host path, never an RPC path. Keep ownership separate from source
 * subscriptions so shutdown can unsubscribe before closing the connection. */
function openOwnedShadowDatabase(path: string, options: { busyTimeoutMs: number }, readonly: boolean) {
  const timeout = z.number().int().min(1).max(1000).parse(options.busyTimeoutMs)
  const identity = () => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Shadow active database must be a regular file')
    return `${stat.dev}:${stat.ino}`
  }
  const expected = identity()
  const db = new Database(path, { readonly, fileMustExist: true, timeout })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    db.close()
  }
  const assertCurrent = () => {
    if (closed || !db.open || identity() !== expected) throw new Error('Shadow active database was closed or replaced')
  }
  try {
    assertCurrent()
  }
  catch (error) {
    close()
    throw error
  }
  return { db, assertCurrent, close }
}

export function openShadowActiveDatabase(path: string, options: { busyTimeoutMs: number }) {
  return openOwnedShadowDatabase(path, options, true)
}

/** The installed runner owns this writable handle for separate shadow tables.
 * The store, not this connection wrapper, enforces the canonical-write boundary. */
export function openShadowStateDatabase(path: string, options: { busyTimeoutMs: number }) {
  return openOwnedShadowDatabase(path, options, false)
}
