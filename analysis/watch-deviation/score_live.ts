/**
 * Score what the pod actually recorded each night against the Apple Watch.
 *
 * usage (repo root): npx tsx analysis/watch-deviation/score_live.ts [side=left] [minHours=3]
 * inputs:  analysis/watch-deviation/data/biometrics.db (pod snapshot)
 *          analysis/watch-deviation/data/watch.json    (parse_watch.py)
 * outputs: analysis/watch-deviation/out/live.json and a markdown table on stdout
 *
 * Pairing (pairing.ts): HR nearest pod row ±60 s, BR ±150 s, HRV = mean pod
 * hrv ±5 min against Watch SDNN (different definitions: SDNN vs pod index).
 * Stages: the side's latest resolved ruleset re-run on the stored vitals,
 * scored per 5-min epoch against the Watch stage at its midpoint.
 */
import Database from 'better-sqlite3'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'
import { runStageClassifier, scoreAgainstReference, stageDurations, type SleepStageBlock } from '@/src/lib/sleep-stages'
import { deviation, fmt, meanWithin, nearest, pairSamples, WINDOWS, type Sample } from './pairing'

const DIR = 'analysis/watch-deviation'
const side = process.argv[2] ?? 'left'
const minHours = Number(process.argv[3] ?? 3)

const watch = JSON.parse(readFileSync(join(DIR, 'data/watch.json'), 'utf8')) as {
  hr: Sample[]
  hrv: Sample[]
  rr: Sample[]
  stages: Array<[number, number, SleepStageBlock['stage']]>
}
const db = new Database(join(DIR, 'data/biometrics.db'), { readonly: true })

const nights = db.prepare(`select id, entered_bed_at s, left_bed_at e from sleep_records
  where side = ? and left_bed_at - entered_bed_at >= ? order by entered_bed_at`).all(side, minHours * 3600) as Array<{ id: number, s: number, e: number }>
const latestConfig = db.prepare(`select generation, payload from biometric_runtime_configs where side = ? order by generation desc limit 1`).get(side) as { generation: number, payload: string } | undefined
const ruleset = latestConfig ? JSON.parse(latestConfig.payload).resolved.sleep_stages.ruleset : DEFAULT_STAGE_RULESET
const quality = (db.prepare(`select quality_score q from calibration_profiles where side = ? and sensor_type = 'piezo' limit 1`).get(side) as { q: number | null } | undefined)?.q ?? 0

const results = nights.map((n) => {
  const s = n.s * 1000
  const e = n.e * 1000
  const rows = db.prepare(`select timestamp t, heart_rate hr, hrv, breathing_rate br from vitals where side = ? and timestamp between ? and ? order by timestamp`)
    .all(side, n.s - 600, n.e + 600) as Array<{ t: number, hr: number | null, hrv: number | null, br: number | null }>
  const mv = db.prepare(`select timestamp t, total_movement m from movement where side = ? and timestamp between ? and ? order by timestamp`)
    .all(side, n.s, n.e) as Array<{ t: number, m: number }>
  const inNight = (xs: Sample[]) => xs.filter(([t]) => t >= s && t <= e)
  const series = (key: 'hr' | 'hrv' | 'br') => rows.map(r => ({ t: r.t * 1000, v: r[key] }))
  const hr = series('hr')
  const br = series('br')
  const hrv = series('hrv')
  const hrW = inNight(watch.hr)
  const brW = inNight(watch.rr)
  const hrvW = inNight(watch.hrv)

  const vitalsData = rows.filter(r => r.t >= n.s && r.t <= n.e).map(r => ({ timestamp: new Date(r.t * 1000), heartRate: r.hr, hrv: r.hrv, breathingRate: r.br }))
  const movementData = mv.map(r => ({ timestamp: new Date(r.t * 1000), totalMovement: r.m }))
  const run = runStageClassifier(vitalsData, movementData, quality, ruleset)
  const ref = watch.stages.filter(([a, b]) => b > s && a < e).map(([start, end, stage]) => ({ start, end, stage }))
  const agreement = scoreAgainstReference(run.epochs, ref)
  const refDur = { wake: 0, light: 0, deep: 0, rem: 0 }
  for (const r of ref) refDur[r.stage] += Math.min(r.end, e) - Math.max(r.start, s)
  const minutes = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v / 60000)]))

  return {
    night: n.id,
    start: new Date(s).toISOString(),
    hours: +((e - s) / 3.6e6).toFixed(1),
    podRows: rows.length,
    hr: { ...deviation(pairSamples(hrW, t => nearest(hr, t, WINDOWS.hr)), hrW.length), watchSamples: hrW.length },
    br: { ...deviation(pairSamples(brW, t => nearest(br, t, WINDOWS.br)), brW.length), watchSamples: brW.length },
    hrv: { ...deviation(pairSamples(hrvW, t => meanWithin(hrv, t, WINDOWS.hrv)), hrvW.length), watchSamples: hrvW.length },
    stages: agreement && {
      epochs: agreement.epochs,
      accuracy: agreement.accuracy,
      kappa: agreement.kappa,
      recall: agreement.recall,
      podMin: minutes(stageDurations(run.epochs)),
      watchMin: minutes(refDur),
    },
  }
}).filter(r => r.hr.watchSamples > 0 || r.stages)

writeFileSync(join(DIR, 'out/live.json'), JSON.stringify({ side, rulesetGeneration: latestConfig?.generation ?? null, calibrationQuality: quality, results }, null, 2))
console.log(`side=${side} ruleset gen=${latestConfig?.generation ?? 'default'} piezo quality=${quality}\n`)
console.log('| night | start (UTC) | h | HR n/watch | HR MAE | HR bias | HR r | BR n | BR MAE | BR bias | HRV n | HRV MAE | HRV bias | stage epochs | acc | kappa |')
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const r of results) {
  console.log(`| ${r.night} | ${r.start.slice(0, 16)} | ${r.hours} | ${r.hr.n}/${r.hr.watchSamples} | ${fmt(r.hr.mae)} | ${fmt(r.hr.bias)} | ${fmt(r.hr.corr, 2)} | ${r.br.n} | ${fmt(r.br.mae)} | ${fmt(r.br.bias)} | ${r.hrv.n} | ${fmt(r.hrv.mae)} | ${fmt(r.hrv.bias)} | ${r.stages?.epochs ?? 0} | ${fmt(r.stages?.accuracy, 2)} | ${fmt(r.stages?.kappa, 2)} |`)
}
