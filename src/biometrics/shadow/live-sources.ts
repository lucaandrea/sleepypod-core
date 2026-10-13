import type Database from 'better-sqlite3'
import { z } from 'zod'
import { ShadowActiveReader } from './active-reader'
import { openShadowFrameSource } from './frame-source'
import type { ShadowSources } from './attempt'

/** Compose the real read-only active reader with the live waveform tap. The
 * owner retains the database connection and must detect path/inode replacement.
 * Polling and final-drain flush use the same bounded, synchronous snapshot. */
export function openShadowLiveSources(options: {
  db: Database.Database
  side: 'left' | 'right'
  startMs: number
  endMs: number
  activeConfigHash: string
  maximumActiveRows: number
  maximumLatenessMs: number
  pollMs: number
  frameBudgets: Parameters<typeof openShadowFrameSource>[0]['budgets']
  context: Parameters<typeof openShadowFrameSource>[0]['context']
  assertDatabaseCurrent: () => void
  signal: AbortSignal
  active: (reading: unknown) => void
  fail: () => void
}): ShadowSources {
  z.number().int().min(1).max(120000).parse(options.maximumLatenessMs)
  z.number().int().min(10).max(Math.min(1000, options.maximumLatenessMs - 1)).parse(options.pollMs)
  function synchronous(action: () => void) {
    const result: unknown = action()
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {})
      throw new Error('Shadow live source callbacks must complete synchronously')
    }
  }
  synchronous(options.assertDatabaseCurrent)
  // Establish the active watermark first; never miss a commit while enabling
  // candidate input, and never substitute historical active rows.
  const reader = new ShadowActiveReader(options.db, { side: options.side, startMs: options.startMs, endMs: options.endMs,
    activeConfigHash: options.activeConfigHash, maximumRows: options.maximumActiveRows })
  let closed = false, waveform: ReturnType<typeof openShadowFrameSource> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    waveform?.close()
    options.signal.removeEventListener('abort', close)
  }
  const fail = () => {
    if (closed) return
    close()
    try {
      options.fail()
    }
    catch { /* Isolate controller errors from the live server's timer. */ }
  }
  const flush = () => {
    if (closed) throw new Error('Shadow live sources are closed')
    synchronous(options.assertDatabaseCurrent)
    const readings = reader.poll()
    synchronous(options.assertDatabaseCurrent)
    for (const reading of readings) {
      if (closed || options.signal.aborted) throw new Error('Shadow active delivery cancelled')
      synchronous(() => options.active(reading))
    }
  }
  try {
    waveform = openShadowFrameSource({ startMs: options.startMs, endMs: options.endMs, budgets: options.frameBudgets,
      signal: options.signal, context: options.context, fail })
    if (options.signal.aborted) close()
    else {
      options.signal.addEventListener('abort', close, { once: true })
      timer = setInterval(() => {
        try {
          flush()
        }
        catch { fail() }
      }, options.pollMs)
    }
    return { frames: waveform.frames, flush, close }
  }
  catch (error) {
    close()
    throw error
  }
}
