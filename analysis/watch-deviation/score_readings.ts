/**
 * Score replayed readings (local-fit --save-readings) per sleep session
 * against the Watch, with the same pairing as score_live.ts, so candidates
 * can be compared night by night including coverage.
 *
 * usage (repo root): npx tsx analysis/watch-deviation/score_readings.ts <out/run-dir> <sessionId> [...]
 * outputs: <run-dir>/sessions.json and a markdown table on stdout
 *
 * coverage = Watch samples that found a pod reading / Watch samples in the
 * session. A candidate that withholds readings lowers error and coverage
 * together, so both are reported.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deviation, fmt, meanWithin, nearest, pairSamples, WINDOWS, type Deviation, type Sample } from './pairing'
import { DATA, openSnapshot } from './paths'

const [runDir, ...ids] = process.argv.slice(2)
const sessionIds = ids.map(Number)
const watch = JSON.parse(readFileSync(join(DATA, 'watch.json'), 'utf8')) as { hr: Sample[], hrv: Sample[], rr: Sample[] }
const db = openSnapshot(join(DATA, 'biometrics.db'))
const sessions = db.prepare(`select id, entered_bed_at * 1000 s, left_bed_at * 1000 e from sleep_records where id in (${sessionIds.map(() => '?').join(',')}) order by entered_bed_at`)
  .all(...sessionIds) as Array<{ id: number, s: number, e: number }>

// Candidate names by config hash prefix, from each candidate's report directory.
const names = new Map<string, string[]>()
for (const d of readdirSync(runDir, { withFileTypes: true }).filter(d => d.isDirectory() && !['readings', 'bundle', 'work'].includes(d.name))) {
  const text = readdirSync(join(runDir, d.name)).map(f => readFileSync(join(runDir, d.name, f), 'utf8')).join('')
  const hash = text.match(/"resolvedHash":\s*"([a-f0-9]{12})/)?.[1]
  if (hash) names.set(hash, [...(names.get(hash) ?? []), d.name])
}

interface Reading { side: string, timestampMs: number, heartRate: number | null, hrvIndex: number | null, breathingRate: number | null }
const readingsDir = join(runDir, 'readings')
const byConfig = new Map<string, Reading[]>()
for (const file of readdirSync(readingsDir).filter(f => f.endsWith('.json'))) {
  const hash = file.replace(/\.json$/, '').split('-').slice(-1)[0]
  const config = names.get(hash)?.join('=') ?? hash
  const raw = JSON.parse(readFileSync(join(readingsDir, file), 'utf8'))
  const rows = (Array.isArray(raw) ? raw : raw.readings) as Reading[]
  byConfig.set(config, [...(byConfig.get(config) ?? []), ...rows.filter(r => r.side === 'left')])
}

const out: Record<string, Record<number, { hr: Deviation, br: Deviation, hrv: Deviation }>> = {}
const lines: string[] = []
for (const [config, readings] of [...byConfig].sort()) {
  out[config] = {}
  for (const s of sessions) {
    const inS = (xs: Sample[]) => xs.filter(([t]) => t >= s.s && t <= s.e)
    const local = readings.filter(r => r.timestampMs >= s.s - 600_000 && r.timestampMs <= s.e + 600_000)
    const hr = local.map(r => ({ t: r.timestampMs, v: r.heartRate }))
    const br = local.map(r => ({ t: r.timestampMs, v: r.breathingRate }))
    const hrv = local.map(r => ({ t: r.timestampMs, v: r.hrvIndex }))
    const hrW = inS(watch.hr)
    const rrW = inS(watch.rr)
    const hrvW = inS(watch.hrv)
    const res = {
      hr: deviation(pairSamples(hrW, t => nearest(hr, t, WINDOWS.hr)), hrW.length),
      br: deviation(pairSamples(rrW, t => nearest(br, t, WINDOWS.br)), rrW.length),
      hrv: deviation(pairSamples(hrvW, t => meanWithin(hrv, t, WINDOWS.hrv)), hrvW.length),
    }
    out[config][s.id] = res
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`
    lines.push(`| ${config} | ${s.id} | ${fmt(res.hr.mae, 2)} | ${fmt(res.hr.bias, 2)} | ${fmt(res.hr.p90)} | ${pct(res.hr.coverage)} | ${fmt(res.br.mae, 2)} | ${fmt(res.br.bias, 2)} | ${pct(res.br.coverage)} | ${fmt(res.hrv.mae)} | ${fmt(res.hrv.bias)} |`)
  }
}
writeFileSync(join(runDir, 'sessions.json'), JSON.stringify(out, null, 2))
console.log('| config | session | HR MAE | HR bias | HR p90 | HR cov | BR MAE | BR bias | BR cov | HRV MAE | HRV bias |')
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const l of lines) console.log(l)
