/**
 * Watch-covered nights and sweep results, loaded once for report.ts and
 * summary.ts so both describe exactly the same numbers.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'
import { runStageClassifier, scoreAgainstReference, type SleepStage, type SleepStageBlock, type StageAgreement } from '@/src/lib/sleep-stages'
import { deviation, meanWithin, nearest, pairSamples, WINDOWS, type Pair, type Point, type Sample } from './pairing'
import { DATA, openSnapshot } from './paths'

export interface Night {
  id: number
  s: number
  e: number
  label: string
  /** Runtime-config generation in effect at bed entry; null before the side had one. */
  gen: number | null
  /** Resolved hash of that generation, for grouping nights that ran the same settings. */
  configHash: string | null
  hr: Point[]
  br: Point[]
  hrPairs: Pair[]
  brPairs: Pair[]
  hrvPairs: Pair[]
  hrW: Sample[]
  brW: Sample[]
  dev: Record<'hr' | 'br' | 'hrv', ReturnType<typeof deviation>>
  stages: StageAgreement | null
  kappa: number | null
  podStages: SleepStageBlock[]
  watchStages: SleepStageBlock[]
}

export interface NightSet {
  side: string
  minHours: number
  nights: Night[]
  configs: Array<{ g: number, t: number, hash: string }>
  rulesetGeneration: number | null
  calibrationQuality: number
  /** Latest applied biometrics migration count of the snapshot, when known. */
  schemaTag: string | null
  /** Algorithm manifest hash of the side's latest runtime config. */
  manifestHash: string | null
}

interface WatchFile { hr: Sample[], hrv: Sample[], rr: Sample[], stages: Array<[number, number, SleepStage]> }

/** Sleep records of at least minHours that overlap any Watch data and yield at least one pair or scored epoch. */
export function loadNights(side: string, minHours: number): NightSet {
  const watch = JSON.parse(readFileSync(join(DATA, 'watch.json'), 'utf8')) as WatchFile
  const db = openSnapshot(join(DATA, 'biometrics.db'))
  const records = db.prepare(`select id, entered_bed_at s, left_bed_at e from sleep_records
    where side = ? and left_bed_at - entered_bed_at >= ? order by entered_bed_at`).all(side, minHours * 3600) as Array<{ id: number, s: number, e: number }>
  const configs = db.prepare(`select generation g, created_at_ms t, resolved_hash hash from biometric_runtime_configs where side = ? order by generation`)
    .all(side) as Array<{ g: number, t: number, hash: string }>
  const latest = db.prepare(`select payload from biometric_runtime_configs where side = ? order by generation desc limit 1`).get(side) as { payload: string } | undefined
  const latestPayload = latest ? JSON.parse(latest.payload) as { manifestHash?: string, resolved: { sleep_stages: { ruleset: typeof DEFAULT_STAGE_RULESET } } } : null
  const ruleset = latestPayload?.resolved.sleep_stages.ruleset ?? DEFAULT_STAGE_RULESET
  const quality = (db.prepare(`select quality_score q from calibration_profiles where side = ? and sensor_type = 'piezo' limit 1`).get(side) as { q: number | null } | undefined)?.q ?? 0
  const schemaTag = (() => {
    try {
      return String((db.prepare('select count(*) n from __drizzle_migrations').get() as { n: number }).n)
    }
    catch {
      return null
    }
  })()

  const nights: Night[] = []
  for (const r of records) {
    const s = r.s * 1000
    const e = r.e * 1000
    const inNight = (xs: Sample[]) => xs.filter(([t]) => t >= s && t <= e)
    const hrW = inNight(watch.hr)
    const brW = inNight(watch.rr)
    const hrvW = inNight(watch.hrv)
    const watchStages = watch.stages.filter(([a, b]) => b > s && a < e).map(([start, end, stage]) => ({ start: Math.max(start, s), end: Math.min(end, e), stage }))
    if (hrW.length === 0 && watchStages.length === 0) continue
    const rows = db.prepare(`select timestamp t, heart_rate hr, hrv, breathing_rate br from vitals where side = ? and timestamp between ? and ? order by timestamp`)
      .all(side, r.s - 600, r.e + 600) as Array<{ t: number, hr: number | null, hrv: number | null, br: number | null }>
    const mv = db.prepare(`select timestamp t, total_movement m from movement where side = ? and timestamp between ? and ? order by timestamp`)
      .all(side, r.s, r.e) as Array<{ t: number, m: number }>
    const series = (key: 'hr' | 'br' | 'hrv') => rows.map(x => ({ t: x.t * 1000, v: x[key] }))
    const hr = series('hr')
    const br = series('br')
    const hrv = series('hrv')
    const hrPairs = pairSamples(hrW, t => nearest(hr, t, WINDOWS.hr))
    const brPairs = pairSamples(brW, t => nearest(br, t, WINDOWS.br))
    const hrvPairs = pairSamples(hrvW, t => meanWithin(hrv, t, WINDOWS.hrv))
    const run = runStageClassifier(
      rows.filter(x => x.t >= r.s && x.t <= r.e).map(x => ({ timestamp: new Date(x.t * 1000), heartRate: x.hr, hrv: x.hrv, breathingRate: x.br })),
      mv.map(x => ({ timestamp: new Date(x.t * 1000), totalMovement: x.m })), quality, ruleset)
    const podStages: SleepStageBlock[] = []
    for (const ep of run.epochs) {
      const last = podStages[podStages.length - 1]
      if (last && last.stage === ep.stage && last.end === ep.start) last.end = ep.start + ep.duration
      else podStages.push({ start: ep.start, end: ep.start + ep.duration, stage: ep.stage })
    }
    const stages = scoreAgainstReference(run.epochs, watchStages)
    if (hrPairs.length === 0 && brPairs.length === 0 && stages == null) continue
    const config = configs.filter(c => c.t <= s).at(-1)
    nights.push({
      id: r.id, s, e,
      gen: config?.g ?? null,
      configHash: config?.hash ?? null,
      label: new Date(s - 12 * 3_600_000).toISOString().slice(5, 10),
      hr: hr.filter(p => p.t >= s && p.t <= e),
      br: br.filter(p => p.t >= s && p.t <= e),
      hrPairs, brPairs, hrvPairs, hrW, brW,
      dev: { hr: deviation(hrPairs, hrW.length), br: deviation(brPairs, brW.length), hrv: deviation(hrvPairs, hrvW.length) },
      stages,
      kappa: stages?.kappa ?? null,
      podStages, watchStages,
    })
  }
  // Two records starting on the same local date get their record id appended.
  for (const n of nights) {
    if (nights.filter(m => m.label.slice(0, 5) === n.label.slice(0, 5)).length > 1) n.label = `${n.label.slice(0, 5)} #${n.id}`
  }
  return { side, minHours, nights, configs, rulesetGeneration: configs.at(-1)?.g ?? null, calibrationQuality: quality, schemaTag, manifestHash: latestPayload?.manifestHash ?? null }
}

export interface Agg { n: number, watch: number, mae: number | null, bias: number | null }
export interface SessionDeviation { n: number, coverage: number, mae: number | null, bias: number | null }
export interface SweepCell {
  config: string
  hr: Agg
  br: Agg
  /** Per sleep-record results, keyed by record id (score_readings.ts). */
  sessions: Record<string, Record<'hr' | 'br', SessionDeviation>>
}

/**
 * A sweep's sessions.json pooled per candidate: MAE and bias weighted by pairs,
 * Watch count recovered from coverage. A directory without one is read as a
 * protocol run: one sub-directory per night, merged.
 */
export function loadSweep(dir: string): SweepCell[] {
  const files = existsSync(join(dir, 'sessions.json'))
    ? [join(dir, 'sessions.json')]
    : (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(dir, d.name, 'sessions.json')).filter(existsSync) : [])
  if (files.length === 0) return []
  const raw: Record<string, Record<string, Record<'hr' | 'br', SessionDeviation>>> = {}
  for (const file of files) {
    for (const [config, sessions] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) as typeof raw)) raw[config] = { ...raw[config], ...sessions }
  }
  const pool = (cells: SessionDeviation[]): Agg => {
    const n = cells.reduce((a, c) => a + c.n, 0)
    const w = cells.reduce((a, c) => a + (c.coverage ? c.n / c.coverage : 0), 0)
    const sum = (k: 'mae' | 'bias') => cells.reduce((a, c) => a + (c[k] ?? 0) * c.n, 0)
    return { n, watch: Math.round(w), mae: n ? sum('mae') / n : null, bias: n ? sum('bias') / n : null }
  }
  return Object.entries(raw).map(([config, sessions]) => ({
    config,
    hr: pool(Object.values(sessions).map(x => x.hr)),
    br: pool(Object.values(sessions).map(x => x.br)),
    sessions,
  }))
}
