// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ShadowContextReader } from '../context'
const at = 1700000000000
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-context-')), path = join(directory, 'presence.json')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE side_settings(side TEXT, away_mode INTEGER); INSERT INTO side_settings VALUES (\'left\',0),(\'right\',0); CREATE TABLE device_settings(id INTEGER, bed_mode TEXT); INSERT INTO device_settings VALUES(1,\'two\');')
  db.pragma('query_only = ON')
  cleanup.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const assertCurrent = vi.fn()
  const reader = new ShadowContextReader(db, path, { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 4096 }, assertCurrent)
  const write = (value: unknown, mtime = at) => {
    writeFileSync(path, JSON.stringify(value))
    utimesSync(path, mtime / 1000, mtime / 1000)
  }
  const sql = (value: string) => {
    db.pragma('query_only = OFF')
    db.exec(value)
    db.pragma('query_only = ON')
  }
  return { db, path, reader, write, sql, assertCurrent }
}
const state = { version: 1, left: { vitals_presence: true, vitals_evidence_ts: at / 1000 }, right: { vitals_presence: false, vitals_evidence_ts: at / 1000 } }
it('uses committed per-side evidence and active sleeper settings rather than virtual UI occupancy', () => {
  const { reader, write, sql } = fixture()
  write(state)
  expect(reader.snapshot({ type: 'piezo-dual' }, at)).toEqual({ activeSides: ['left', 'right'], leftOccupied: true, rightOccupied: false, pumpContextKnown: false })
  sql('UPDATE side_settings SET away_mode=1 WHERE side=\'right\'')
  expect(reader.snapshot({}, at).activeSides).toEqual(['left'])
  sql('UPDATE device_settings SET bed_mode=\'solo-right\'')
  expect(reader.snapshot({}, at).activeSides).toEqual([])
  sql('UPDATE side_settings SET away_mode=0')
  expect(reader.snapshot({}, at).activeSides).toEqual(['right'])
})
it.each(['missing', 'malformed', 'version', 'stale_file', 'future_file', 'stale_evidence', 'future_evidence', 'oversize', 'symlink'])('preserves unknown presence for %s evidence', (mode) => {
  const { reader, write, path } = fixture()
  if (mode !== 'missing') write(state)
  if (mode === 'malformed') writeFileSync(path, '{')
  if (mode === 'version') write({ ...state, version: 2 })
  if (mode === 'stale_file') write(state, at - 300001)
  if (mode === 'future_file') write(state, at + 1000)
  if (mode === 'stale_evidence') write({ ...state, left: { ...state.left, vitals_evidence_ts: at / 1000 - 301 }, right: null })
  if (mode === 'future_evidence') write({ ...state, left: { ...state.left, vitals_evidence_ts: at / 1000 + 1 }, right: null })
  if (mode === 'oversize') write({ ...state, extra: 'x'.repeat(4096) })
  if (mode === 'symlink') {
    rmSync(path)
    writeFileSync(path + '.target', JSON.stringify(state))
    symlinkSync(path + '.target', path)
  }
  expect(reader.snapshot({}, at)).toMatchObject({ leftOccupied: null, rightOccupied: null })
})
it('does not let one missing side erase valid evidence on the other side', () => {
  const { reader, write } = fixture()
  write({ ...state, right: { vitals_presence: false, vitals_evidence_ts: null } })
  expect(reader.snapshot({}, at)).toMatchObject({ leftOccupied: true, rightOccupied: null })
})
it('marks incomplete or invalid settings unknown rather than guessing two sleepers', () => {
  const { reader, sql } = fixture()
  sql('DELETE FROM side_settings WHERE side=\'right\'')
  expect(reader.snapshot({}, at).activeSides).toBeNull()
  sql('INSERT INTO side_settings VALUES(\'right\',0); UPDATE device_settings SET bed_mode=\'unexpected\'')
  expect(reader.snapshot({}, at).activeSides).toBeNull()
})
it('requires both pump sides in this attempt and expires or invalidates incomplete updates', () => {
  const { reader } = fixture()
  expect(reader.snapshot({ type: 'frzHealth', left: { pump: { rpm: 1200 } } }, at).pumpContextKnown).toBe(false)
  expect(reader.snapshot({ type: 'frzHealth', left: { pumpRpm: 0 }, right: { pump: { duty: '10' } } }, at).pumpContextKnown).toBe(true)
  expect(reader.snapshot({}, at + 5000).pumpContextKnown).toBe(true)
  expect(reader.snapshot({}, at + 5001).pumpContextKnown).toBe(false)
  expect(reader.snapshot({ type: 'frzHealth', left: { rpm: 0 }, right: { rpm: 0 } }, at + 5001).pumpContextKnown).toBe(true)
  expect(reader.snapshot({ type: 'frzHealth', left: { rpm: 0 }, right: {} }, at + 5002).pumpContextKnown).toBe(false)
})
it('propagates replacement and clock errors instead of reporting a healthy context', () => {
  const { reader, assertCurrent } = fixture()
  reader.snapshot({}, at)
  expect(() => reader.snapshot({}, at - 1)).toThrow(/clock/)
  assertCurrent.mockImplementation(() => {
    throw new Error('database replaced')
  })
  expect(() => reader.snapshot({}, at)).toThrow('database replaced')
})
