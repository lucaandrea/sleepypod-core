import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { thermalDataset } from '../thermal-dataset'
import { migratedComfortDatabase } from './databaseFixture'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState } from '../policy'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const start = Date.parse('2026-10-20T22:00:00Z'), end = start + 8 * 3600000, now = end + 86400000

function fixture(options: { environment?: 'test' | 'production', eligible?: boolean, research?: boolean, variableTarget?: boolean, side?: 'left' | 'right', sampleAt?: (index: number) => number } = {}) {
  const database = migratedComfortDatabase()
  databases.push(database)
  const store = createComfortStore(database)
  const state = defaultComfortState(), side = options.side ?? 'left'
  for (let index = 0; index < 49; index++) {
    const at = options.sampleAt?.(index) ?? start + index * 300000
    store.commit(side, state, { ...comfortEvent(at, 'preview', 'Synthetic fixture'),
      eligible: options.eligible ?? true,
      thermalContext: { targetF: options.variableTarget ? 70 + index % 5 : 70, waterF: 70, roomF: 75, humidity: 50 },
      ...(options.research ? { thermalObservation: { version: 1 as const, purpose: 'comfort_research' as const, bedroomConfiguration: 'e'.repeat(64) } } : {}),
      preview: { format: 1, runId: randomUUID(), environment: options.environment ?? 'production', buildRevision: 'a'.repeat(40),
        hardwareIdentity: 'b'.repeat(64), session: 'night', start, end, timezone: 'UTC', scheduleRevision: 'c'.repeat(64),
        policy: { minimumF: 69, maximumF: 71, sensorAware: true, followBedtime: false, offsetF: 0 },
        ...(options.research ? { bedroom: { state: 'ready' as const, offsetF: 0 as const, reason: 'Fixture', sourceIds: ['temperature', 'humidity'], expiresAt: at + 60000, configuration: 'e'.repeat(64) } } : {}),
        scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied', presenceSourceKey: 'd'.repeat(64),
        mechanicallyQuiet: true, deviceFresh: true, sensorReady: true, manualPaused: false },
    })
  }
  store.saveFeedback('left', { date: '2026-10-21', comfort: 'warm' }, comfortEvent(now, 'feedback', 'Fixture'))
  return { database, store }
}
describe('thermal learning observation provenance', () => {
  it('joins one actual night with a morning check-in, preserving side and thermal context', () => {
    const { database } = fixture()
    expect(thermalDataset(database, 'left', now)).toEqual([{ date: '2026-10-21', correction: -1, targetF: 70, waterF: 70, roomF: 75, humidity: 50 }])
    expect(thermalDataset(database, 'right', now)).toEqual([])
  })
  it('rejects test origins, withheld proposals, unmatched sides and ambiguous temperature curves', () => {
    for (const options of [{ environment: 'test' as const }, { eligible: false }, { variableTarget: true }, { side: 'right' as const }]) {
      expect(thermalDataset(fixture(options).database, 'left', now)).toEqual([])
    }
  })
  it('does not train on an unfinished night or substitute check-ins alone for sensor data', () => {
    const { database, store } = fixture()
    expect(thermalDataset(database, 'left', end - 1)).toEqual([])
    const report = store.learning?.('left', null, 'UTC', now)
    expect(report).toMatchObject({ nights: 1, suggestedOffsetF: null })
    database.prepare('DELETE FROM comfort_events').run()
    expect(thermalDataset(database, 'left', now)).toEqual([])
  })
  it('learns from separately qualified thermal observations while heart-rate proposals remain withheld', () => {
    const { database } = fixture({ eligible: false, research: true })
    expect(thermalDataset(database, 'left', now)).toHaveLength(1)
    const rows = database.prepare('SELECT event FROM comfort_events WHERE json_extract(event,\'$.kind\')=\'preview\'').all() as { event: string }[]
    expect(rows.every(row => JSON.parse(row.event).eligible === false)).toBe(true)
  })
  it('uses actual timestamps rather than bucket edges for the four-hour coverage boundary', () => {
    const shortened = fixture({ sampleAt: index => start + index * 300000 + (index === 0 ? 299000 : 0) })
    expect(thermalDataset(shortened.database, 'left', now)).toEqual([])
    const shifted = fixture({ sampleAt: index => start + index * 300000 + 299000 })
    expect(thermalDataset(shifted.database, 'left', now)).toHaveLength(1)
  })
  it('accepts an exact ten-minute gap but rejects one extra millisecond hidden by bucket rounding', () => {
    for (const excessMs of [0, 1]) {
      const { database } = fixture({ sampleAt: index => start + index * 300000 + (index === 25 ? excessMs : 0) })
      database.prepare('DELETE FROM comfort_events WHERE observed_at = ?').run(start + 24 * 300000)
      expect(thermalDataset(database, 'left', now)).toHaveLength(excessMs === 0 ? 1 : 0)
    }
  })
  it('rejects sparse observations and source changes even when they have enough sample rows', () => {
    for (const modification of [
      'DELETE FROM comfort_events WHERE observed_at > ' + (start + 60 * 60000) + ' AND json_extract(event,\'$.kind\')=\'preview\'',
      'UPDATE comfort_events SET event=json_set(event,\'$.at\',json_extract(event,\'$.at\')+900000) WHERE observed_at=' + (start + 48 * 300000),
      'UPDATE comfort_events SET event=json_set(event,\'$.preview.presenceSourceKey\',\'' + 'f'.repeat(64) + '\') WHERE observed_at=' + start,
      'UPDATE comfort_events SET event=json_set(event,\'$.thermalObservation.bedroomConfiguration\',\'' + 'f'.repeat(64) + '\') WHERE observed_at=' + start,
    ]) {
      const { database } = fixture({ eligible: false, research: true })
      database.exec(modification)
      expect(thermalDataset(database, 'left', now)).toEqual([])
    }
  })
})
