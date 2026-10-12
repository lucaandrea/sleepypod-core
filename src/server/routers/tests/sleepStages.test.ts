/**
 * sleepStages router against real in-memory sleepypod.db and biometrics.db
 * with migrations applied: the stored classifier round-trips through the
 * side_settings JSON column, and the preview classifies a stored night.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mainSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { deliverRuntimeOutbox } from '@/src/biometrics/profiles/runtime'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  MOVEMENT_ONLY_STAGE_RULESET,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

const dbHolder = vi.hoisted(() => ({ main: null as unknown, bio: null as unknown }))

vi.mock('@/src/db', () => ({
  get db() { return dbHolder.main },
  get biometricsDb() { return dbHolder.bio },
}))

const { sleepStagesRouter, loadStageClassifier } = await import('@/src/server/routers/sleepStages')
const caller = sleepStagesRouter.createCaller({})

const MIN = 60_000
// 2026-10-10 23:00:00 UTC
const BED = new Date(Date.UTC(2026, 9, 10, 23))
const at = (minutes: number) => new Date(BED.getTime() + minutes * MIN)

const movementOnly: StageClassifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }

describe('sleepStages router', () => {
  let mainRaw: Database.Database
  let bioRaw: Database.Database
  let bio: ReturnType<typeof drizzle<typeof bioSchema>>

  beforeEach(() => {
    mainRaw = new Database(':memory:')
    const main = drizzle(mainRaw, { schema: mainSchema })
    migrate(main, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
    main.insert(mainSchema.sideSettings).values([
      { side: 'left', name: 'Left' },
      { side: 'right', name: 'Right' },
    ]).run()
    dbHolder.main = main

    bioRaw = new Database(':memory:')
    bio = drizzle(bioRaw, { schema: bioSchema })
    migrate(bio, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
    dbHolder.bio = bio
  })

  afterEach(() => {
    mainRaw.close()
    bioRaw.close()
  })

  /** One 60-minute night: HR dips in the middle 20 minutes, calm movement. */
  function seedNight(side: 'left' | 'right' = 'left') {
    const [record] = bio.insert(bioSchema.sleepRecords).values({
      side,
      enteredBedAt: BED,
      leftBedAt: at(60),
      sleepDurationSeconds: 3600,
      timesExitedBed: 0,
      presentIntervals: [],
      notPresentIntervals: [],
    }).returning().all()
    const hrs = [70, 70, 70, 70, 60, 60, 60, 60, 70, 70, 70, 70]
    bio.insert(bioSchema.vitals).values(hrs.map((heartRate, i) => ({
      side, timestamp: at(i * 5), heartRate, hrv: 60, breathingRate: 14,
    }))).run()
    bio.insert(bioSchema.movement).values(hrs.map((_, i) => ({ side, timestamp: at(i * 5), totalMovement: 10 }))).run()
    return record
  }

  describe('getClassifier', () => {
    it('reports the defaults for a side with nothing stored', async () => {
      const out = await caller.getClassifier({ side: 'left' })
      expect(out.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      expect(out.isDefault).toBe(true)
      expect(out.engines.map(e => e.id)).toEqual(['rules'])
      expect(out.presets.map(p => p.id)).toEqual(['default', 'movementOnly'])
    })

    it('falls back to the defaults when the stored value no longer validates', async () => {
      mainRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run(JSON.stringify({ engine: 'neural' }), 'left')
      const out = await caller.getClassifier({ side: 'left' })
      expect(out.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      expect(out.isDefault).toBe(true)
    })
  })

  describe('setClassifier', () => {
    it('stores a classifier per side and resets with null', async () => {
      const saved = await caller.setClassifier({ side: 'right', classifier: movementOnly })
      expect(saved).toMatchObject({ classifier: movementOnly, isDefault: false, activation: { generation: 1, state: 'pending_delivery' } })
      expect((await caller.getClassifier({ side: 'right' })).classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      deliverRuntimeOutbox(dbHolder.main as ReturnType<typeof drizzle<typeof mainSchema>>, bio)
      const projected = bio.select().from(bioSchema.biometricRuntimeConfigs).get()
      if (!projected) throw new Error('Missing runtime projection')
      for (const component of ['heart_rate', 'breathing_rate', 'hrv_index']) bio.insert(bioSchema.biometricRuntimeReceipts).values({
        side: 'right', component, generation: 1, appliedHash: projected.resolvedHash, effectiveSampleTimeMs: BED.getTime(), state: 'applied', heartbeatAtMs: Date.now(),
      }).run()
      const applied = await caller.getClassifier({ side: 'right' })
      expect(applied.classifier).toEqual(movementOnly)
      expect(applied.provenance.generation).toBe(1)
      expect((await caller.getClassifier({ side: 'left' })).isDefault).toBe(true)
      expect(await loadStageClassifier('right')).toEqual(movementOnly)
      expect(await caller.setClassifier({ side: 'right', classifier: null })).toMatchObject({ classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true, activation: { generation: 2 } })
      expect(mainRaw.prepare('SELECT stage_classifier FROM side_settings WHERE side = ?').get('right')).toEqual({ stage_classifier: null })
    })

    it('rejects an invalid ruleset at the boundary', async () => {
      const bad = { engine: 'rules', ruleset: { ...DEFAULT_STAGE_RULESET, outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRate: { min: 130, max: 45 } } } }
      await expect(caller.setClassifier({ side: 'left', classifier: bad as StageClassifier })).rejects.toThrow(/min must be less than or equal to max/)
    })

    it('throws NOT_FOUND when the side has no settings row', async () => {
      mainRaw.prepare('DELETE FROM side_settings WHERE side = ?').run('left')
      await expect(caller.setClassifier({ side: 'left', classifier: movementOnly })).rejects.toThrow(/Side settings for left not found/)
    })
  })

  describe('previewClassifier', () => {
    it('returns empty results when the side has no nights', async () => {
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out).toEqual({ sleepRecordId: null, enteredBedAt: null, leftBedAt: null, hasReference: false, saved: null, candidate: null })
    })

    it('throws NOT_FOUND for another side\'s night', async () => {
      const record = seedNight('right')
      await expect(caller.previewClassifier({ side: 'left', sleepRecordId: record.id, classifier: movementOnly }))
        .rejects.toThrow(new RegExp(`Sleep record ${record.id} not found`))
    })

    it('classifies the latest night with the saved and candidate rules', async () => {
      const record = seedNight()
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out.sleepRecordId).toBe(record.id)
      expect(out.enteredBedAt).toBe(BED.getTime())
      expect(out.saved?.distribution.deep).toBeGreaterThan(0)
      expect(out.candidate?.distribution).toEqual({ wake: 0, light: 100, deep: 0, rem: 0 })
      expect(out.hasReference).toBe(false)
      expect(out.saved?.agreement).toBeNull()
    })

    it('scores both against reference stages', async () => {
      seedNight()
      bio.insert(bioSchema.referenceStages).values({ side: 'left', source: 'apple_watch', start: BED, end: at(60), stage: 'light' }).run()
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out.hasReference).toBe(true)
      expect(out.candidate?.agreement).toMatchObject({ epochs: 12, accuracy: 1 })
      expect(out.saved?.agreement?.accuracy).toBeLessThan(1)
    })
  })
})
