import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState, MANUAL_PAUSE_MS } from '../policy'

import { migratedComfortDatabase } from './databaseFixture'

describe('personal comfort SQLite persistence', () => {
  it('retains settings, bed-entry selection, manual pause and consumed feedback through reopening', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'comfort-store-'))
    const filename = path.join(directory, 'state.db')
    let database = migratedComfortDatabase(filename)
    try {
      const store = createComfortStore(database)
      expect(store.read('right').config.mode).toBe('off')
      const state = { ...defaultComfortState(), pausedUntil: Date.now() + MANUAL_PAUSE_MS, feedbackThrough: '2026-10-24', offsetF: -2,
        bedtime: { session: 'night-1', revision: 'b'.repeat(64), sourceKey: 'a'.repeat(64), entryAt: 1792922400000, confirmedAt: 1792923000000, shiftMinutes: -20 } }
      store.commit('left', state, comfortEvent(Date.now(), 'manual_pause', 'Manual pause'))
      database.close()
      database = new Database(filename)
      expect(createComfortStore(database).read('left')).toEqual(state)
      expect(createComfortStore(database).history('left')[0].kind).toBe('manual_pause')
    }
    finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not replace corrupt state with defaults or accept invalid dates', () => {
    const database = migratedComfortDatabase()
    try {
      database.prepare('INSERT INTO comfort_states VALUES (?, ?)').run('left', '{broken')
      expect(() => createComfortStore(database).read('left')).toThrow()
      expect(() => createComfortStore(database).saveFeedback('right', { date: '2026-02-30', comfort: 'cold' }, comfortEvent(1, 'feedback', 'bad'))).toThrow()
      expect(createComfortStore(database).feedback('right')).toEqual([])
    }
    finally { database.close() }
  })

  it('updates one check-in per local date and prunes old observations without dropping state', () => {
    const database = migratedComfortDatabase()
    try {
      const store = createComfortStore(database)
      const now = Date.parse('2026-10-25T12:00:00Z')
      store.commit('left', defaultComfortState(), comfortEvent(now - 31 * 86_400_000, 'preview', 'old'))
      store.saveFeedback('left', { date: '2026-10-24', comfort: 'warm' }, comfortEvent(now, 'feedback', 'warm'))
      store.saveFeedback('left', { date: '2026-10-24', comfort: 'cold' }, comfortEvent(now + 1, 'feedback', 'cold'))
      store.prune(now)
      expect(store.feedback('left')).toEqual([{ date: '2026-10-24', comfort: 'cold' }])
      expect(store.history('left')).toHaveLength(2)
      expect(store.read('left')).toEqual(defaultComfortState())
    }
    finally { database.close() }
  })

  it('rolls state back when the event insert fails', () => {
    const database = migratedComfortDatabase()
    try {
      const store = createComfortStore(database)
      store.commit('left', defaultComfortState())
      database.exec('CREATE TRIGGER reject_comfort BEFORE INSERT ON comfort_events BEGIN SELECT RAISE(ABORT, \'test\'); END')
      expect(() => store.commit('left', { ...defaultComfortState(), offsetF: 2 }, comfortEvent(1, 'preview', 'test'))).toThrow()
      expect(store.read('left').offsetF).toBe(0)
    }
    finally { database.close() }
  })
})
