// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '@/src/db/schema'
import { requestManualActivation } from '../activation'
import { listActivationHistory } from '../history'
import { defaultConfig } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'
it('paginates immutable side-specific audit history without leaking internal request keys', () => {
  const raw = new Database(':memory:')
  try {
    const db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: 'src/db/migrations' })
    for (let generation = 0; generation < 53; generation++) requestManualActivation(db, {
      side: 'left', action: 'reset', revisionId: null, expectedGeneration: generation, expectedResolvedHash: configHash(defaultConfig),
      boundary: 'immediate', requester: 'fixture', idempotencyKey: `request-${generation}`, allowUnvalidated: true,
    })
    const first = listActivationHistory(db, 'left')
    expect(first.items).toHaveLength(50)
    expect(first.items[0].generation).toBe(53)
    expect(first.nextGeneration).toBe(4)
    expect(first.items[0]).not.toHaveProperty('idempotencyKey')
    const second = listActivationHistory(db, 'left', first.nextGeneration ?? undefined)
    expect(second.items.map(row => row.generation)).toEqual([3, 2, 1])
    expect(second.nextGeneration).toBeNull()
    expect(listActivationHistory(db, 'right').items).toEqual([])
  }
  finally { raw.close() }
})
