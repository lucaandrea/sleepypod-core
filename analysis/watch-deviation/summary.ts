/**
 * De-identified, shareable result of the shared protocol: out/summary.json.
 *
 * usage (repo root, in the container): npx tsx analysis/watch-deviation/summary.ts [sweepDir=out/protocol]
 *
 * Contains only error statistics: per-night and pooled deviation from the
 * Watch per metric, stage agreement, coarse agreement bins, and per-candidate
 * sweep results, plus algorithm hashes. Nights are relative indexes. It never
 * contains timestamps, dates, record or pod ids, raw readings or Watch samples;
 * a check refuses to write anything that looks like a timestamp or a date.
 * Sharing it is the user's choice; the HTML report stays local.
 */
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { loadSweep, type Night } from './nights'
import { deviation, type Pair } from './pairing'
import { OUT } from './paths'
import { loadProtocol, protocolNights } from './protocol'

const sweepDir = resolve(process.argv[2] ?? join(OUT, 'protocol'))
const protocol = loadProtocol()
const set = protocolNights(protocol)

const round = (x: number | null, d = 3) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d
const dev = z.object({ n: z.number().int(), coverage: z.number().nullable(), mae: z.number().nullable(), bias: z.number().nullable(), p90: z.number().nullable(), r: z.number().nullable() })
const sweepDev = z.object({ n: z.number().int(), coverage: z.number().nullable(), mae: z.number().nullable(), bias: z.number().nullable() })
const bin = z.object({ from: z.number(), to: z.number(), n: z.number().int(), mae: z.number(), bias: z.number() })
const stageName = z.enum(['wake', 'light', 'deep', 'rem'])
const summarySchema = z.object({
  formatVersion: z.literal('deviation-summary-v1'),
  protocolVersion: z.string(),
  context: z.object({
    side: z.enum(['left', 'right']),
    manifestHash: z.string().nullable(),
    schemaMigrations: z.string().nullable(),
    calibrationQuality: z.number(),
    nights: z.number().int(),
  }),
  nights: z.array(z.object({
    index: z.number().int(),
    hours: z.number(),
    configGeneration: z.number().int().nullable(),
    configHash: z.string().nullable(),
    heartRate: dev,
    breathingRate: dev,
    hrv: dev,
    stages: z.object({ epochs: z.number().int(), accuracy: z.number(), kappa: z.number().nullable(), recall: z.record(stageName, z.number().nullable()), confusion: z.record(stageName, z.record(stageName, z.number().int())) }).nullable(),
  })),
  pooled: z.object({ heartRate: dev, breathingRate: dev, hrv: dev, stageKappaMean: z.number().nullable() }),
  agreementBins: z.object({ heartRate: z.array(bin), breathingRate: z.array(bin) }),
  sweep: z.array(z.object({
    candidate: z.string(),
    overrides: z.array(z.object({ path: z.string(), value: z.unknown() })),
    pooled: z.object({ heartRate: sweepDev, breathingRate: sweepDev }),
    perNight: z.array(z.object({ index: z.number().int(), heartRate: sweepDev, breathingRate: sweepDev })),
  })),
  privacy: z.object({ excluded: z.array(z.string()) }),
}).strict()

const devOut = (d: ReturnType<typeof deviation>) => ({ n: d.n, coverage: round(d.coverage), mae: round(d.mae), bias: round(d.bias), p90: round(d.p90), r: round(d.corr) })

/** Mean error per Watch-value bin; bins with fewer than 5 pairs are dropped. */
function bins(pairs: Pair[], width: number) {
  const groups = new Map<number, Pair[]>()
  for (const p of pairs) {
    const from = Math.floor(p[1] / width) * width
    groups.set(from, [...(groups.get(from) ?? []), p])
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([, ps]) => ps.length >= 5).map(([from, ps]) => ({
    from, to: from + width, n: ps.length,
    mae: round(ps.reduce((a, [p, w]) => a + Math.abs(p - w), 0) / ps.length) as number,
    bias: round(ps.reduce((a, [p, w]) => a + (p - w), 0) / ps.length) as number,
  }))
}

const indexOf = new Map(set.nights.map((n, i) => [String(n.id), i]))
const pooledPairs = (pick: (n: Night) => Pair[], watch: (n: Night) => number) => deviation(set.nights.flatMap(pick), set.nights.reduce((a, n) => a + watch(n), 0))
const kappas = set.nights.flatMap(n => n.kappa == null ? [] : [n.kappa])

const candidateOverrides = new Map(protocol.candidates.map(c => [c.id, c.overrides]))
const sweep = loadSweep(sweepDir).map((cell) => {
  // score_readings.ts names a config by its candidate ids joined with '='.
  const candidate = cell.config.split('=').find(id => candidateOverrides.has(id)) ?? cell.config
  const sd = (x: { n: number, coverage: number, mae: number | null, bias: number | null }) => ({ n: x.n, coverage: round(x.coverage), mae: round(x.mae), bias: round(x.bias) })
  return {
    candidate,
    overrides: candidateOverrides.get(candidate) ?? [],
    pooled: {
      heartRate: { n: cell.hr.n, coverage: cell.hr.watch ? round(cell.hr.n / cell.hr.watch) : null, mae: round(cell.hr.mae), bias: round(cell.hr.bias) },
      breathingRate: { n: cell.br.n, coverage: cell.br.watch ? round(cell.br.n / cell.br.watch) : null, mae: round(cell.br.mae), bias: round(cell.br.bias) },
    },
    perNight: Object.entries(cell.sessions).flatMap(([id, s]) => indexOf.has(id) ? [{ index: indexOf.get(id) as number, heartRate: sd(s.hr), breathingRate: sd(s.br) }] : [])
      .sort((a, b) => a.index - b.index),
  }
}).sort((a, b) => (a.pooled.breathingRate.mae ?? Infinity) - (b.pooled.breathingRate.mae ?? Infinity))

const summary = summarySchema.parse({
  formatVersion: 'deviation-summary-v1',
  protocolVersion: protocol.protocolVersion,
  context: { side: set.side as 'left' | 'right', manifestHash: set.manifestHash, schemaMigrations: set.schemaTag, calibrationQuality: round(set.calibrationQuality) ?? 0, nights: set.nights.length },
  nights: set.nights.map((n, index) => ({
    index,
    hours: Math.round(((n.e - n.s) / 3.6e6) * 2) / 2,
    configGeneration: n.gen,
    configHash: n.configHash?.slice(0, 12) ?? null,
    heartRate: devOut(n.dev.hr),
    breathingRate: devOut(n.dev.br),
    hrv: devOut(n.dev.hrv),
    stages: n.stages && { epochs: n.stages.epochs, accuracy: round(n.stages.accuracy) as number, kappa: round(n.stages.kappa), recall: Object.fromEntries(Object.entries(n.stages.recall).map(([k, v]) => [k, round(v)])), confusion: n.stages.confusion },
  })),
  pooled: {
    heartRate: devOut(pooledPairs(n => n.hrPairs, n => n.hrW.length)),
    breathingRate: devOut(pooledPairs(n => n.brPairs, n => n.brW.length)),
    hrv: devOut(pooledPairs(n => n.hrvPairs, n => n.dev.hrv.n / (n.dev.hrv.coverage || 1))),
    stageKappaMean: kappas.length ? round(kappas.reduce((a, b) => a + b, 0) / kappas.length) : null,
  },
  agreementBins: { heartRate: bins(set.nights.flatMap(n => n.hrPairs), 5), breathingRate: bins(set.nights.flatMap(n => n.brPairs), 2) },
  sweep,
  privacy: { excluded: ['timestamps and dates (nights are relative indexes)', 'sleep record ids', 'pod id and hostname', 'raw waveforms', 'pod and Watch readings (only errors and coarse Watch-value bins)'] },
})

// Refuse to write anything that could place a night in time.
const leaks: string[] = []
const walk = (v: unknown, path: string) => {
  if (typeof v === 'number' && Math.abs(v) >= 1e9) leaks.push(`${path}=${v}`)
  else if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/.test(v)) leaks.push(`${path}=${v}`)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
}
walk(summary, 'summary')
if (leaks.length) throw new Error(`summary.json would leak time information: ${leaks.slice(0, 5).join(', ')}`)

writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const best = summary.sweep[0]
console.log(`summary: ${join(OUT, 'summary.json')} · ${summary.context.nights} nights · pooled HR MAE ${summary.pooled.heartRate.mae} · BR MAE ${summary.pooled.breathingRate.mae} (bias ${summary.pooled.breathingRate.bias}) · kappa ${summary.pooled.stageKappaMean}${
  best ? ` · best breathing candidate ${best.candidate}: MAE ${best.pooled.breathingRate.mae}, bias ${best.pooled.breathingRate.bias}` : ' · no sweep'}`)
