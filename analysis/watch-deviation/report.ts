/**
 * Self-contained HTML report of pod vs Apple Watch deviation: out/report.html.
 *
 * usage (repo root, in the container): npx tsx analysis/watch-deviation/report.ts [side=left] [minHours=3] [sweepDir ...]
 * inputs:  biometrics.db + watch.json from $SP_ANALYSIS_DATA (paths.ts);
 *          optional sweep run dirs with sessions.json (score_readings.ts)
 *
 * Charts (inline SVG, light + dark, hover tooltips, a table under each):
 *   1. Bland-Altman for HR and breathing: is the error a constant offset or rate-dependent?
 *   2. Night overlays: pod vs Watch HR and breathing over time; breaks are pod gaps.
 *   3. Hypnograms: Watch above pod per night.
 *   4. Trend: MAE and bias per metric per night, with runtime-config generation markers.
 *   5. Sweeps: breathing interval-ratio heatmaps; HR peak-score error-vs-coverage.
 *
 * Health data stays local: the file is written to out/ and never published.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'
import { runStageClassifier, scoreAgainstReference, type SleepStage, type SleepStageBlock } from '@/src/lib/sleep-stages'
import { deviation, meanWithin, nearest, pairSamples, WINDOWS, type Pair, type Point, type Sample } from './pairing'
import { DATA, OUT, openSnapshot } from './paths'

const [sideArg, minHoursArg, ...sweepDirs] = process.argv.slice(2)
const side = sideArg ?? 'left'
const minHours = Number(minHoursArg ?? 3)

// ---------------------------------------------------------------- data
const watch = JSON.parse(readFileSync(join(DATA, 'watch.json'), 'utf8')) as {
  hr: Sample[]
  hrv: Sample[]
  rr: Sample[]
  stages: Array<[number, number, SleepStage]>
}
const db = openSnapshot(join(DATA, 'biometrics.db'))
const records = db.prepare(`select id, entered_bed_at s, left_bed_at e from sleep_records
  where side = ? and left_bed_at - entered_bed_at >= ? order by entered_bed_at`).all(side, minHours * 3600) as Array<{ id: number, s: number, e: number }>
const configs = db.prepare(`select generation g, created_at_ms t from biometric_runtime_configs where side = ? order by generation`)
  .all(side) as Array<{ g: number, t: number }>
const latest = db.prepare(`select payload from biometric_runtime_configs where side = ? order by generation desc limit 1`).get(side) as { payload: string } | undefined
const ruleset = latest ? JSON.parse(latest.payload).resolved.sleep_stages.ruleset : DEFAULT_STAGE_RULESET
const quality = (db.prepare(`select quality_score q from calibration_profiles where side = ? and sensor_type = 'piezo' limit 1`).get(side) as { q: number | null } | undefined)?.q ?? 0

interface Night {
  id: number
  s: number
  e: number
  label: string
  gen: number | null
  hr: Point[]
  br: Point[]
  hrPairs: Pair[]
  brPairs: Pair[]
  hrW: Sample[]
  brW: Sample[]
  dev: Record<'hr' | 'br' | 'hrv', ReturnType<typeof deviation>>
  kappa: number | null
  podStages: SleepStageBlock[]
  watchStages: SleepStageBlock[]
}

const nights: Night[] = []
for (const r of records) {
  const s = r.s * 1000
  const e = r.e * 1000
  const inNight = (xs: Sample[]) => xs.filter(([t]) => t >= s && t <= e)
  const hrW = inNight(watch.hr)
  const brW = inNight(watch.rr)
  const hrvW = inNight(watch.hrv)
  const nightStages = watch.stages.filter(([a, b]) => b > s && a < e).map(([start, end, stage]) => ({ start: Math.max(start, s), end: Math.min(end, e), stage }))
  if (hrW.length === 0 && nightStages.length === 0) continue
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
  const run = runStageClassifier(
    rows.filter(x => x.t >= r.s && x.t <= r.e).map(x => ({ timestamp: new Date(x.t * 1000), heartRate: x.hr, hrv: x.hrv, breathingRate: x.br })),
    mv.map(x => ({ timestamp: new Date(x.t * 1000), totalMovement: x.m })), quality, ruleset)
  const podStages: SleepStageBlock[] = []
  for (const ep of run.epochs) {
    const last = podStages[podStages.length - 1]
    if (last && last.stage === ep.stage && last.end === ep.start) last.end = ep.start + ep.duration
    else podStages.push({ start: ep.start, end: ep.start + ep.duration, stage: ep.stage })
  }
  const kappa = scoreAgainstReference(run.epochs, nightStages)?.kappa ?? null
  if (hrPairs.length === 0 && brPairs.length === 0 && kappa == null) continue
  const gen = configs.filter(c => c.t <= s).at(-1)?.g ?? null
  nights.push({
    id: r.id, s, e, gen,
    label: new Date(s - 12 * 3_600_000).toISOString().slice(5, 10),
    hr: hr.filter(p => p.t >= s && p.t <= e), br: br.filter(p => p.t >= s && p.t <= e),
    hrPairs, brPairs, hrW, brW,
    dev: { hr: deviation(hrPairs, hrW.length), br: deviation(brPairs, brW.length), hrv: deviation(pairSamples(hrvW, t => meanWithin(hrv, t, WINDOWS.hrv)), hrvW.length) },
    kappa,
    podStages, watchStages: nightStages,
  })
}

// Two records starting on the same local date get their record id appended.
for (const n of nights) {
  if (nights.filter(m => m.label.slice(0, 5) === n.label.slice(0, 5)).length > 1) n.label = `${n.label.slice(0, 5)} #${n.id}`
}

interface SweepCell { config: string, hr: Agg, br: Agg }
interface Agg { n: number, watch: number, mae: number | null, bias: number | null }
function loadSweep(dir: string): SweepCell[] {
  const path = join(dir, 'sessions.json')
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, Record<'hr' | 'br', { n: number, coverage: number, mae: number | null, bias: number | null }>>>
  const pool = (cells: Array<{ n: number, coverage: number, mae: number | null, bias: number | null }>): Agg => {
    const n = cells.reduce((a, c) => a + c.n, 0)
    const w = cells.reduce((a, c) => a + (c.coverage ? c.n / c.coverage : 0), 0)
    const sum = (k: 'mae' | 'bias') => cells.reduce((a, c) => a + (c[k] ?? 0) * c.n, 0)
    return { n, watch: Math.round(w), mae: n ? sum('mae') / n : null, bias: n ? sum('bias') / n : null }
  }
  return Object.entries(raw).map(([config, sessions]) => ({
    config,
    hr: pool(Object.values(sessions).map(x => x.hr)),
    br: pool(Object.values(sessions).map(x => x.br)),
  }))
}
const sweeps = sweepDirs.map(d => ({ dir: d, cells: loadSweep(d) }))

// ---------------------------------------------------------------- svg helpers
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f1 = (x: number | null | undefined, d = 1) => x == null ? '–' : x.toFixed(d)
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16)

function niceTicks(lo: number, hi: number, count = 5) {
  const span = hi - lo || 1
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(m => span / m <= count + 0.5) ?? mag * 10
  const ticks: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6))
  return ticks
}
function extent(xs: number[], pad = 0.05): [number, number] {
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  const p = (hi - lo || Math.abs(hi) || 1) * pad
  return [lo - p, hi + p]
}

interface Frame { w: number, h: number, l: number, r: number, t: number, b: number }
const FRAME: Frame = { w: 640, h: 220, l: 44, r: 16, t: 12, b: 28 }
function scale(d: [number, number], r: [number, number]) {
  return (v: number) => r[0] + ((v - d[0]) / (d[1] - d[0] || 1)) * (r[1] - r[0])
}

function axes(fr: Frame, x: (v: number) => number, xTicks: number[], xFmt: (v: number) => string, y: (v: number) => number, yTicks: number[], yFmt: (v: number) => string, yLabel: string) {
  let s = ''
  for (const v of yTicks) s += `<line class="grid" x1="${fr.l}" x2="${fr.w - fr.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${fr.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(yFmt(v))}</text>`
  for (const v of xTicks) s += `<text class="tick" x="${x(v)}" y="${fr.h - fr.b + 16}" text-anchor="middle">${esc(xFmt(v))}</text>`
  s += `<line class="axis" x1="${fr.l}" x2="${fr.w - fr.r}" y1="${fr.h - fr.b}" y2="${fr.h - fr.b}"/>`
  s += `<text class="unit" x="${fr.l}" y="${fr.t - 2}">${esc(yLabel)}</text>`
  return s
}

/** A polyline broken wherever consecutive points are more than gapMs apart or null. */
function path(points: Point[], x: (t: number) => number, y: (v: number) => number, gapMs: number) {
  let d = ''
  let prev: Point | null = null
  for (const p of points) {
    if (p.v == null) {
      prev = null
      continue
    }
    d += `${prev && p.t - prev.t <= gapMs ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
    prev = p
  }
  return d
}

const tableOf = (caption: string, head: string[], rows: Array<Array<string | number>>) =>
  `<details><summary>Table: ${esc(caption)}</summary><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`

const SERIES_VAR: Record<string, string> = { s1: 'var(--series-1)', s2: 'var(--series-2)', s3: 'var(--series-3)', s4: 'var(--series-4)' }
const legend = (items: Array<{ cls: string, label: string, kind: 'line' | 'dot' | 'rect' }>) =>
  `<div class="legend">${items.map(i => `<span><svg width="18" height="10" aria-hidden="true">${
    i.kind === 'line'
      ? `<line x1="1" x2="17" y1="5" y2="5" style="stroke:${SERIES_VAR[i.cls]};stroke-width:2;stroke-linecap:round"/>`
      : i.kind === 'dot' ? `<circle cx="9" cy="5" r="4" style="fill:${SERIES_VAR[i.cls]}"/>` : `<rect x="1" y="1" width="16" height="8" rx="2" style="fill:${SERIES_VAR[i.cls]}"/>`
  }</svg>${esc(i.label)}</span>`).join('')}</div>`

// ---------------------------------------------------------------- 1. Bland-Altman
function blandAltman(title: string, unit: string, pairs: Array<Pair & { night?: string }>) {
  if (pairs.length < 3) return `<section><h3>${esc(title)}</h3><p class="note">Not enough paired readings.</p></section>`
  const pts = pairs.map(([p, w]) => ({ m: (p + w) / 2, d: p - w }))
  const mean = pts.reduce((a, q) => a + q.d, 0) / pts.length
  const sd = Math.sqrt(pts.reduce((a, q) => a + (q.d - mean) ** 2, 0) / (pts.length - 1))
  const lo = mean - 1.96 * sd
  const hi = mean + 1.96 * sd
  // No offset-vs-proportional verdict: with pod-Watch correlation this low the
  // slope of the difference on either the mean or the Watch value mostly
  // reflects how little the pod tracks the Watch, not the shape of the error.
  const r = deviation(pairs, pairs.length).corr
  const fr = { ...FRAME, h: 260 }
  const xd = extent(pts.map(q => q.m))
  const yd = extent([...pts.map(q => q.d), lo, hi, 0])
  const x = scale(xd, [fr.l, fr.w - fr.r])
  const y = scale(yd, [fr.h - fr.b, fr.t])
  let s = axes(fr, x, niceTicks(xd[0], xd[1]), v => String(v), y, niceTicks(yd[0], yd[1]), v => String(v), `pod − Watch (${unit})`)
  s += `<line class="zero" x1="${fr.l}" x2="${fr.w - fr.r}" y1="${y(0)}" y2="${y(0)}"/>`
  for (const [v, name] of [[mean, `bias ${f1(mean, 2)}`], [lo, `−1.96 SD ${f1(lo, 1)}`], [hi, `+1.96 SD ${f1(hi, 1)}`]] as Array<[number, string]>) {
    s += `<line class="ref" x1="${fr.l}" x2="${fr.w - fr.r}" y1="${y(v)}" y2="${y(v)}"/><text class="reflabel" x="${fr.w - fr.r - 4}" y="${y(v) - 4}" text-anchor="end">${esc(name)}</text>`
  }
  for (const q of pts) s += `<circle class="s1 dot" cx="${x(q.m).toFixed(1)}" cy="${y(q.d).toFixed(1)}" r="3.5"/>`
  const hits = pts.map(q => `<circle class="hit" cx="${x(q.m).toFixed(1)}" cy="${y(q.d).toFixed(1)}" r="8" tabindex="-1" data-tip="${esc(`${f1(q.d, 1)} ${unit} · mean ${f1(q.m, 1)}`)}"/>`).join('')
  return `<section><h3>${esc(title)}</h3>
<p class="note">${pts.length} pairs · bias <b>${f1(mean, 2)} ${unit}</b> · limits of agreement ${f1(lo, 1)} to ${f1(hi, 1)} · pod–Watch correlation r ${f1(r, 2)}. x = mean of pod and Watch; lines are the bias and 95% limits of agreement.</p>
<svg viewBox="0 0 ${fr.w} ${fr.h}" role="img" aria-label="${esc(title)}">${s}<g class="hits">${hits}</g></svg>
${tableOf(title, ['bias', 'SD', 'lower LoA', 'upper LoA', 'r', 'pairs'], [[f1(mean, 2), f1(sd, 2), f1(lo, 2), f1(hi, 2), f1(r, 2), pts.length]])}</section>`
}

// ---------------------------------------------------------------- 2. overlays
function overlay(n: Night, which: 'hr' | 'br') {
  const unit = which === 'hr' ? 'bpm' : 'breaths/min'
  const pod = which === 'hr' ? n.hr : n.br
  const w = which === 'hr' ? n.hrW : n.brW
  const values = [...pod.flatMap(p => p.v == null ? [] : [p.v]), ...w.map(([, v]) => v)]
  if (values.length < 2) return ''
  const fr = { ...FRAME, h: 180 }
  const xd: [number, number] = [n.s, n.e]
  const yd = extent(values, 0.08)
  const x = scale(xd, [fr.l, fr.w - fr.r])
  const y = scale(yd, [fr.h - fr.b, fr.t])
  const hourTicks: number[] = []
  for (let t = Math.ceil(n.s / 3_600_000) * 3_600_000; t <= n.e; t += 2 * 3_600_000) hourTicks.push(t)
  let s = axes(fr, x, hourTicks, v => `${hhmm(v)}Z`, y, niceTicks(yd[0], yd[1], 4), v => String(v), unit)
  s += `<path class="s1 line" d="${path(pod, x, y, 3 * 60_000)}"/>`
  for (const [t, v] of w) s += `<circle class="s2 dot" cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"/>`
  const data = JSON.stringify({ x0: xd[0], x1: xd[1], l: fr.l, r: fr.w - fr.r, t: fr.t, b: fr.h - fr.b, unit,
    pod: pod.filter(p => p.v != null).map(p => [p.t, +(p.v as number).toFixed(1)]), watch: w.map(([t, v]) => [t, +v.toFixed(1)]) })
  const dev = which === 'hr' ? n.dev.hr : n.dev.br
  return `<figure><figcaption>${which === 'hr' ? 'Heart rate' : 'Breathing'} · MAE ${f1(dev.mae, 2)} · bias ${f1(dev.bias, 2)} · coverage ${Math.round(dev.coverage * 100)}%</figcaption>
<svg class="xhair" viewBox="0 0 ${fr.w} ${fr.h}" role="img" aria-label="${esc(`Night ${n.label} ${which}`)}" data-series='${esc(data)}'>${s}<line class="cross" x1="0" x2="0" y1="${fr.t}" y2="${fr.h - fr.b}" visibility="hidden"/></svg></figure>`
}

// ---------------------------------------------------------------- 3. hypnograms
const STAGES: SleepStage[] = ['wake', 'rem', 'light', 'deep']
const STAGE_CLS: Record<SleepStage, string> = { wake: 's4', rem: 's3', light: 's1', deep: 's2' }
function hypnogram(n: Night) {
  const fr = { w: 640, h: 150, l: 56, r: 16, t: 8, b: 24 }
  const x = scale([n.s, n.e], [fr.l, fr.w - fr.r])
  const lane = (fr.h - fr.t - fr.b) / 2
  let s = ''
  const row = (blocks: SleepStageBlock[], i: number, name: string) => {
    const top = fr.t + i * lane
    const band = (lane - 10) / STAGES.length
    s += `<text class="tick" x="${fr.l - 6}" y="${top + lane / 2}" text-anchor="end">${name}</text>`
    for (const b of blocks) {
      const k = STAGES.indexOf(b.stage)
      const x0 = x(b.start)
      const wpx = Math.max(1, x(b.end) - x0 - 1)
      s += `<rect class="${STAGE_CLS[b.stage]} fill" x="${x0.toFixed(1)}" y="${(top + 2 + k * band).toFixed(1)}" width="${wpx.toFixed(1)}" height="${(band - 2).toFixed(1)}" rx="2" tabindex="-1" data-tip="${esc(`${name}: ${b.stage} ${hhmm(b.start)}–${hhmm(b.end)}Z`)}"/>`
    }
  }
  row(n.watchStages, 0, 'Watch')
  row(n.podStages, 1, 'Pod')
  for (let t = Math.ceil(n.s / 3_600_000) * 3_600_000; t <= n.e; t += 2 * 3_600_000) s += `<text class="tick" x="${x(t)}" y="${fr.h - 6}" text-anchor="middle">${hhmm(t)}Z</text>`
  return `<figure><figcaption>Sleep stages · kappa ${f1(n.kappa, 2)} (0 = chance agreement). Rows top to bottom: wake, REM, light, deep.</figcaption>
<svg viewBox="0 0 ${fr.w} ${fr.h}" role="img" aria-label="${esc(`Night ${n.label} stages`)}">${s}</svg></figure>`
}

// ---------------------------------------------------------------- 4. trend
function trend(title: string, unit: string, get: (n: Night) => { a: number | null, b?: number | null }, names: [string, string?]) {
  const pts = nights.map((n, i) => ({ i, n, ...get(n) }))
  const vals = pts.flatMap(p => [p.a, p.b].filter((v): v is number => v != null))
  if (vals.length === 0) return ''
  const fr = { ...FRAME, h: 200 }
  const xd: [number, number] = [-0.5, nights.length - 0.5]
  const yd = extent([...vals, 0], 0.1)
  const x = scale(xd, [fr.l, fr.w - fr.r])
  const y = scale(yd, [fr.h - fr.b, fr.t])
  let s = axes(fr, x, pts.map(p => p.i), i => nights[i]?.label ?? '', y, niceTicks(yd[0], yd[1], 4), v => String(v), unit)
  s += `<line class="zero" x1="${fr.l}" x2="${fr.w - fr.r}" y1="${y(0)}" y2="${y(0)}"/>`
  // Generation markers between the nights where the config in effect changed.
  for (let i = 1; i < nights.length; i++) {
    if (nights[i].gen !== nights[i - 1].gen) {
      const gx = (x(i) + x(i - 1)) / 2
      s += `<line class="marker" x1="${gx}" x2="${gx}" y1="${fr.t}" y2="${fr.h - fr.b}"/><text class="reflabel" x="${gx + 3}" y="${fr.t + 10}">gen ${nights[i].gen ?? '–'}</text>`
    }
  }
  const series = (key: 'a' | 'b', cls: string) => {
    let d = ''
    let prev = false
    for (const p of pts) {
      const v = p[key]
      if (v == null) {
        prev = false
        continue
      }
      d += `${prev ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(v).toFixed(1)}`
      prev = true
    }
    let out = `<path class="${cls} line" d="${d}"/>`
    for (const p of pts) if (p[key] != null) out += `<circle class="${cls} dot ring" cx="${x(p.i).toFixed(1)}" cy="${y(p[key] as number).toFixed(1)}" r="4"/>`
    return out
  }
  s += series('a', 's1')
  if (names[1]) s += series('b', 's2')
  const hits = pts.map(p => `<rect class="hit" x="${x(p.i) - 20}" y="${fr.t}" width="40" height="${fr.h - fr.t - fr.b}" tabindex="-1" data-tip="${esc(`${p.n.label} (#${p.n.id}, gen ${p.n.gen ?? '–'}) · ${names[0]} ${f1(p.a, 2)}${names[1] ? ` · ${names[1]} ${f1(p.b ?? null, 2)}` : ''} ${unit}`)}"/>`).join('')
  return `<section><h3>${esc(title)}</h3>${legend([{ cls: 's1', label: names[0], kind: 'line' }, ...(names[1] ? [{ cls: 's2', label: names[1], kind: 'line' as const }] : [])])}
<svg viewBox="0 0 ${fr.w} ${fr.h}" role="img" aria-label="${esc(title)}">${s}<g class="hits">${hits}</g></svg>
${tableOf(title, ['night', 'record', 'gen', names[0], ...(names[1] ? [names[1]] : [])], pts.map(p => [p.n.label, p.n.id, p.n.gen ?? '–', f1(p.a, 2), ...(names[1] ? [f1(p.b ?? null, 2)] : [])]))}</section>`
}

// ---------------------------------------------------------------- 5. sweeps
function heatmap(title: string, cells: SweepCell[], value: (c: SweepCell) => number | null, diverging: boolean, unit: string) {
  const grid = cells.flatMap((c) => {
    const m = c.config.match(/br([\d.]+)-([\d.]+)/) ?? (c.config.startsWith('defaults') ? [null, '0.5', '1.5'] : null)
    return m ? [{ lo: Number(m[1]), hi: Number(m[2]), v: value(c), c }] : []
  })
  if (grid.length < 2) return ''
  const los = [...new Set(grid.map(g => g.lo))].sort()
  const his = [...new Set(grid.map(g => g.hi))].sort()
  const cw = 110
  const ch = 40
  const l = 90
  const t = 36
  const vs = grid.flatMap(g => g.v == null ? [] : [g.v])
  const vmin = Math.min(...vs)
  const vmax = Math.max(...vs)
  const span = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1
  // One hue whose opacity follows the value (sequential), or blue below zero and
  // red above with opacity by |value| (diverging; zero fades to the surface).
  // Strong cells switch their label to surface ink to stay readable.
  const strength = (v: number) => diverging ? Math.abs(v) / span : (v - vmin) / (vmax - vmin || 1)
  const fill = (v: number) => `fill:${diverging ? (v >= 0 ? 'var(--div-pos)' : 'var(--div-neg)') : 'var(--series-1)'};fill-opacity:${(0.12 + strength(v) * 0.78).toFixed(2)}`
  let s = `<text class="unit" x="${l}" y="12">upper ratio →</text>`
  his.forEach((h, j) => {
    s += `<text class="tick" x="${l + j * cw + cw / 2}" y="${t - 4}" text-anchor="middle">${h}</text>`
  })
  los.forEach((lo, i) => {
    s += `<text class="tick" x="${l - 8}" y="${t + i * ch + ch / 2 + 4}" text-anchor="end">lower ${lo}</text>`
    his.forEach((hi, j) => {
      const g = grid.find(q => q.lo === lo && q.hi === hi)
      if (!g || g.v == null) return
      const best = g.v === (diverging ? vs.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a) : vmin)
      s += `<rect x="${l + j * cw + 1}" y="${t + i * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" style="${fill(g.v)}" ${best ? 'class="best"' : ''} tabindex="-1" data-tip="${esc(`lower ${lo} · upper ${hi}: ${f1(g.v, 2)} ${unit} (${g.c.config})`)}"/>`
      s += `<text class="cell${strength(g.v) > 0.55 ? ' strong' : ''}" x="${l + j * cw + cw / 2}" y="${t + i * ch + ch / 2 + 4}" text-anchor="middle">${f1(g.v, 2)}${best ? ' ★' : ''}</text>`
    })
  })
  const h = t + los.length * ch + 8
  return `<figure><figcaption>${esc(title)} (${unit}; ★ = best)</figcaption><svg class="heat" viewBox="0 0 ${l + his.length * cw + 8} ${h}" role="img" aria-label="${esc(title)}">${s}</svg>
${tableOf(title, ['config', 'lower', 'upper', unit], grid.map(g => [g.c.config, g.lo, g.hi, f1(g.v, 3)]))}</figure>`
}

function coverageCurve(cells: SweepCell[]) {
  const pts = cells.flatMap((c) => {
    const m = c.config.match(/mps([\d.]+)/)
    const mps = c.config.startsWith('defaults') ? 0.4 : m ? Number(m[1]) : null
    return mps == null || c.hr.mae == null ? [] : [{ mps, cov: c.hr.watch ? c.hr.n / c.hr.watch : 0, mae: c.hr.mae, config: c.config }]
  }).sort((a, b) => a.mps - b.mps)
  if (pts.length < 2) return ''
  const fr = { ...FRAME, h: 240 }
  const xd = extent(pts.map(p => p.cov * 100), 0.1)
  const yd = extent([...pts.map(p => p.mae), 0], 0.1)
  const x = scale(xd, [fr.l, fr.w - fr.r])
  const y = scale(yd, [fr.h - fr.b, fr.t])
  let s = axes(fr, x, niceTicks(xd[0], xd[1]), v => `${v}%`, y, niceTicks(yd[0], yd[1], 4), v => String(v), 'HR MAE (bpm) vs Watch coverage')
  s += `<path class="s1 line" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.cov * 100).toFixed(1)},${y(p.mae).toFixed(1)}`).join('')}"/>`
  for (const p of pts) {
    s += `<circle class="s1 dot ring" cx="${x(p.cov * 100)}" cy="${y(p.mae)}" r="4.5"/><text class="reflabel" x="${x(p.cov * 100) + 7}" y="${y(p.mae) - 7}">${p.mps}</text>`
    s += `<circle class="hit" cx="${x(p.cov * 100)}" cy="${y(p.mae)}" r="12" tabindex="-1" data-tip="${esc(`minimumPeakScore ${p.mps}: MAE ${f1(p.mae, 2)} bpm at ${Math.round(p.cov * 100)}% coverage`)}"/>`
  }
  return `<figure><figcaption>Heart-rate guard trade-off: each point is a minimumPeakScore (labelled); right = more Watch readings matched, down = smaller error.</figcaption>
<svg viewBox="0 0 ${fr.w} ${fr.h}" role="img" aria-label="HR error versus coverage">${s}</svg>
${tableOf('HR guard trade-off', ['minimumPeakScore', 'coverage', 'MAE bpm'], pts.map(p => [p.mps, `${Math.round(p.cov * 100)}%`, f1(p.mae, 2)]))}</figure>`
}

// ---------------------------------------------------------------- page
const allHr = nights.flatMap(n => n.hrPairs)
const allBr = nights.flatMap(n => n.brPairs)
// Breathing runs merge into one interval-ratio grid (first run wins a duplicate config).
const brCells = [...new Map(sweeps.flatMap(sw => sw.cells).filter(c => /^br[\d.]+-[\d.]+$|^defaults/.test(c.config))
  .map(c => [c.config.startsWith('defaults') ? 'br0.5-1.5' : c.config.split('=')[0], c] as const).reverse()).values()]
const sweepHtml = `${heatmap('Breathing MAE by interval ratios', brCells, c => c.br.mae, false, 'breaths/min')}${
  heatmap('Breathing bias by interval ratios', brCells, c => c.br.bias, true, 'breaths/min')}${
  sweeps.map(sw => coverageCurve(sw.cells)).join('')}`

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pod vs Watch</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--page:#f9f9f7;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--seq-lo:#cde2fb;--seq-hi:#104281;--div-neg:#2a78d6;--div-pos:#e34948;--div-mid:#f0efec}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--ink:#fff;--ink-2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--seq-lo:#184f95;--seq-hi:#cde2fb;--div-neg:#3987e5;--div-pos:#e66767;--div-mid:#383835}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--ink:#fff;--ink-2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--seq-lo:#184f95;--seq-hi:#cde2fb;--div-neg:#3987e5;--div-pos:#e66767;--div-mid:#383835}
body{margin:0;background:var(--page)}
.viz-root{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--page);padding:24px 16px;max-width:1000px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}h3{font-size:15px;margin:20px 0 4px}
.note,figcaption{color:var(--ink-2);font-size:13px;margin:2px 0 6px}
section,figure{background:var(--surface-1);border:1px solid var(--grid);border-radius:10px;padding:12px;margin:10px 0}
svg{width:100%;height:auto;display:block;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.zero{stroke:var(--axis);stroke-width:1.5}
.ref{stroke:var(--muted);stroke-width:1}.marker{stroke:var(--muted);stroke-width:1}
.tick,.unit,.reflabel{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.reflabel{fill:var(--ink-2)}
.cell.strong{fill:var(--surface-1)}
.cell{fill:var(--ink);font-size:12px;font-variant-numeric:tabular-nums;pointer-events:none}
.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.s1.line{stroke:var(--series-1)}.s2.line{stroke:var(--series-2)}
.s1.dot,.s1.fill{fill:var(--series-1)}.s2.dot,.s2.fill{fill:var(--series-2)}.s3.fill{fill:var(--series-3)}.s4.fill{fill:var(--series-4)}
.s1.line+line{}.dot{stroke:none}.ring{stroke:var(--surface-1);stroke-width:2}.s1.dot:not(.ring){opacity:.55}
.hit{fill:transparent;stroke:none;cursor:default}.hit:hover,.fill:hover{outline:none}
.best{stroke:var(--ink);stroke-width:2}
.cross{stroke:var(--muted);stroke-width:1}
.legend svg{width:18px;height:10px;display:inline-block}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--ink-2);font-size:12px;margin:2px 0 4px}.legend span{display:inline-flex;align-items:center;gap:6px}
.legend .line{stroke-width:2}.legend .s1.line{stroke:var(--series-1)}.legend .s2.line{stroke:var(--series-2)}.legend .dot,.legend rect{stroke:none}
.legend .s3{fill:var(--series-3)}.legend .s4{fill:var(--series-4)}.legend .s1:not(.line){fill:var(--series-1)}.legend .s2:not(.line){fill:var(--series-2)}
details{margin-top:6px;color:var(--ink-2);font-size:12px}table{border-collapse:collapse;margin-top:4px;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--grid);padding:3px 8px;text-align:right}th{color:var(--ink-2);font-weight:600}
.heat{max-width:480px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media (max-width:720px){.grid2{grid-template-columns:1fr}}
.night{border-top:1px solid var(--grid);margin-top:18px;padding-top:6px}
#tip{position:fixed;pointer-events:none;background:var(--surface-1);color:var(--ink);border:1px solid var(--grid);border-radius:6px;padding:5px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.12);display:none;z-index:9;max-width:320px}
#tip b{font-weight:650}#tip .k{display:inline-block;width:12px;height:2px;margin-right:6px;vertical-align:middle}
</style></head><body><div class="viz-root">
<h1>Pod vs Apple Watch</h1>
<p class="note">Side ${esc(side)} · ${nights.length} Watch-covered nights of at least ${minHours} h · stages re-run with ruleset gen ${configs.at(-1)?.g ?? 'default'} · piezo quality ${quality}. Deviation is pod − Watch; the goal is near-zero bias and error. Generated ${esc(new Date().toISOString().slice(0, 16))}Z.</p>

<h2>4 · Trend over nights</h2>
<p class="note">Vertical lines mark where the runtime-config generation in effect at bed entry changed. HRV compares the pod's IBI-variability index with Watch SDNN (not like-for-like yet).</p>
${trend('Heart rate', 'bpm', n => ({ a: n.dev.hr.mae, b: n.dev.hr.bias }), ['MAE', 'bias'])}
${trend('Breathing rate', 'breaths/min', n => ({ a: n.dev.br.mae, b: n.dev.br.bias }), ['MAE', 'bias'])}
${trend('HRV', 'ms', n => ({ a: n.dev.hrv.mae, b: n.dev.hrv.bias }), ['MAE', 'bias'])}
${trend('Sleep stages', 'kappa', n => ({ a: n.kappa }), ['kappa'])}

<h2>1 · Agreement (Bland-Altman, all nights pooled)</h2>
<div class="grid2">${blandAltman('Heart rate', 'bpm', allHr)}${blandAltman('Breathing rate', 'breaths/min', allBr)}</div>

<h2>5 · Parameter sweeps (off-pod replays)</h2>
${sweepHtml || '<p class="note">No sweep runs given.</p>'}

<h2>2 & 3 · Nights</h2>
${legend([{ cls: 's1', label: 'Pod', kind: 'line' }, { cls: 's2', label: 'Watch', kind: 'dot' }])}
${legend([{ cls: 's4', label: 'wake', kind: 'rect' }, { cls: 's3', label: 'REM', kind: 'rect' }, { cls: 's1', label: 'light', kind: 'rect' }, { cls: 's2', label: 'deep', kind: 'rect' }])}
${nights.slice().reverse().map(n => `<div class="night"><h3>${esc(n.label)} · record ${n.id} · ${((n.e - n.s) / 3.6e6).toFixed(1)} h · gen ${n.gen ?? '–'}</h3>
<div class="grid2">${overlay(n, 'hr')}${overlay(n, 'br')}</div>${hypnogram(n)}</div>`).join('')}
<div id="tip" role="status"></div>
</div>
<script>
(() => {
  const tip = document.getElementById('tip')
  const show = (e, build) => { tip.replaceChildren(); build(tip); tip.style.display = 'block'
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px' }
  const hide = () => { tip.style.display = 'none' }
  document.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('pointermove', e => show(e, t => { const b = document.createElement('b'); b.textContent = el.dataset.tip; t.append(b) }))
    el.addEventListener('pointerleave', hide)
  })
  const near = (arr, t, tol) => { let best = null, d = Infinity; for (const p of arr) { const k = Math.abs(p[0] - t); if (k < d && k <= tol) { d = k; best = p } } return best }
  document.querySelectorAll('svg.xhair').forEach(svg => {
    const s = JSON.parse(svg.dataset.series); const line = svg.querySelector('.cross')
    svg.addEventListener('pointermove', e => {
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY
      const p = pt.matrixTransform(svg.getScreenCTM().inverse())
      if (p.x < s.l || p.x > s.r) { hide(); line.setAttribute('visibility', 'hidden'); return }
      const t = s.x0 + (p.x - s.l) / (s.r - s.l) * (s.x1 - s.x0)
      line.setAttribute('x1', p.x); line.setAttribute('x2', p.x); line.setAttribute('visibility', 'visible')
      const pod = near(s.pod, t, 180000), w = near(s.watch, t, 300000)
      show(e, tt => {
        const time = document.createElement('div'); time.textContent = new Date(t).toISOString().slice(11, 16) + 'Z'; tt.append(time)
        for (const [name, v, color] of [['Pod', pod, 'var(--series-1)'], ['Watch', w, 'var(--series-2)']]) {
          const row = document.createElement('div'); const k = document.createElement('span'); k.className = 'k'; k.style.background = color
          const b = document.createElement('b'); b.textContent = v ? v[1] + ' ' + s.unit : '–'
          row.append(k, b, document.createTextNode(' ' + name)); tt.append(row)
        }
      })
    })
    svg.addEventListener('pointerleave', () => { hide(); line.setAttribute('visibility', 'hidden') })
  })
})()
</script></body></html>`

writeFileSync(join(OUT, 'report.html'), html)
console.log(`report: ${join(OUT, 'report.html')} · ${nights.length} nights · ${allHr.length} HR pairs · ${allBr.length} BR pairs · sweeps ${sweeps.map(s => `${s.dir}:${s.cells.length}`).join(' ') || 'none'}`)
