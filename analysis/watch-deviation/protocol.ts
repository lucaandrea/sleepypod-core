/**
 * Shared-protocol helper for run_protocol.sh.
 *
 * usage (repo root, in the container):
 *   npx tsx analysis/watch-deviation/protocol.ts sessions     → the protocol's Watch-covered sleep-record ids, oldest first, space-separated
 *   npx tsx analysis/watch-deviation/protocol.ts candidates   → writes out/protocol-candidates.json for scripts/biometrics-local-fit
 *   npx tsx analysis/watch-deviation/protocol.ts side         → the protocol's side
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { loadNights } from './nights'
import { WINDOWS } from './pairing'
import { OUT } from './paths'

export const protocolSchema = z.object({
  protocolVersion: z.literal('deviation-protocol-v1'),
  description: z.string(),
  side: z.enum(['left', 'right']),
  minHours: z.number().positive(),
  // Longer records are bed-presence drift, not one night's sleep.
  maxHours: z.number().positive(),
  maxNights: z.number().int().positive(),
  pairing: z.object({ heartRateMs: z.number(), breathingRateMs: z.number(), hrvMs: z.number() }),
  candidates: z.array(z.object({ id: z.string().regex(/^[\w.-]+$/), overrides: z.array(z.object({ path: z.string(), value: z.unknown() })) })).min(1),
})
export type Protocol = z.infer<typeof protocolSchema>

export function loadProtocol(): Protocol {
  const protocol = protocolSchema.parse(JSON.parse(readFileSync('analysis/watch-deviation/protocol.json', 'utf8')))
  // Summaries are only comparable if everyone pairs the same way.
  const { pairing } = protocol
  if (pairing.heartRateMs !== WINDOWS.hr || pairing.breathingRateMs !== WINDOWS.br || pairing.hrvMs !== WINDOWS.hrv) {
    throw new Error('protocol.json pairing windows differ from pairing.ts WINDOWS')
  }
  return protocol
}

/** The protocol's nights: Watch-covered records of minHours–maxHours, the newest maxNights. */
export function protocolNights(protocol: Protocol) {
  const set = loadNights(protocol.side, protocol.minHours)
  const nights = set.nights.filter(n => (n.e - n.s) / 3.6e6 <= protocol.maxHours)
  return { ...set, nights: nights.slice(-protocol.maxNights) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const protocol = loadProtocol()
  const command = process.argv[2]
  if (command === 'sessions') {
    const ids = protocolNights(protocol).nights.map(n => n.id)
    if (ids.length === 0) throw new Error('No Watch-covered nights: import Apple Watch data first (Upload Apple Watch data, or parse_watch.py)')
    console.log(ids.join(' '))
  }
  else if (command === 'side') {
    console.log(protocol.side)
  }
  else if (command === 'candidates') {
    // local-fit always adds the shipped defaults itself.
    const candidates = protocol.candidates.filter(c => c.overrides.length > 0)
    writeFileSync(join(OUT, 'protocol-candidates.json'), JSON.stringify(candidates, null, 2))
    console.log(`${candidates.length} candidates + defaults → ${join(OUT, 'protocol-candidates.json')}`)
  }
  else {
    throw new Error('usage: protocol.ts sessions | candidates | side')
  }
}
