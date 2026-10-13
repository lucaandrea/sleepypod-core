// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ShadowStore } from '../store'
import { submitInstalledShadow } from '../submission'
import { inspectInstalledShadowHost, loadInstalledShadowHost } from '../installed-host'
import { openShadowStateDatabase } from '../active-database'
import { installedShadowIdentity } from '../device-identity'
import { submissionFixture, submissionEntry, submissionTime } from './fixtures/submission'
vi.mock('../installed-host', () => ({ inspectInstalledShadowHost: vi.fn(), loadInstalledShadowHost: vi.fn() }))
vi.mock('../active-database', () => ({ openShadowStateDatabase: vi.fn() }))
vi.mock('../device-identity', () => ({ installedShadowIdentity: vi.fn() }))
vi.mock('@/src/streaming/piezoStream', () => ({ getSensorFrameTimes: () => ({ 'piezo-dual': submissionTime }) }))
const paths = { workerPath: '/installed/shadow-host.cjs', pythonPath: '/installed/python', modulesPath: '/installed/modules',
  configurationDatabase: '/installed/config.db', biometricsDatabase: '/installed/bio.db', presenceFile: '/run/presence' }
const policy = { maximumRuns: 10, maximumPoints: 100, maximumBytes: 100000 }
let db: Database.Database, now: number
beforeEach(() => {
  vi.resetAllMocks()
  db = new Database(':memory:')
  migrate(drizzle(db), { migrationsFolder: 'src/db/biometrics-migrations' })
  now = submissionTime
})
afterEach(() => db.close())
function setup() {
  const owned = { host: { admit: vi.fn() }, close: vi.fn() }
  const open = vi.fn().mockResolvedValue(owned), guard = vi.fn()
  class Store extends ShadowStore {
    constructor(raw: Database.Database, limits: unknown) { super(raw, limits, () => now) }
  }
  const inspected = { api: { ShadowStore: Store, openProfiledShadowHost: open,
    readInstalledShadowQualifications: () => ({ entries: [submissionEntry] }) }, assertCurrent: guard }
  vi.mocked(loadInstalledShadowHost).mockReturnValue(inspected as unknown as ReturnType<typeof loadInstalledShadowHost>)
  vi.mocked(inspectInstalledShadowHost).mockResolvedValue(inspected as unknown as Awaited<ReturnType<typeof inspectInstalledShadowHost>>)
  const handle = { db, assertCurrent: vi.fn(), close: vi.fn() }
  vi.mocked(openShadowStateDatabase).mockReturnValue(handle)
  vi.mocked(installedShadowIdentity).mockReturnValue(vi.fn())
  return { owned, open, guard, handle }
}

it('checks admission inside the creation transaction and closes owned admission resources', async () => {
  const { owned, open, handle } = setup(), input = submissionFixture()
  owned.host.admit.mockImplementation(() => {
    expect(db.inTransaction).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM biometric_shadow_runs').get()).toEqual({ n: 0 })
  })
  const run = await submitInstalledShadow(input, paths, policy, 50)
  expect(run).toMatchObject({ state: 'pending', plan: input.plan })
  expect(open).toHaveBeenCalledWith(input.plan, expect.objectContaining(paths), null, undefined)
  expect(owned.host.admit).toHaveBeenCalledOnce()
  expect(owned.close).toHaveBeenCalledOnce()
  expect(handle.close).toHaveBeenCalledOnce()
})

it('returns exact retries before probing changed health and rejects plan substitution', async () => {
  setup()
  const input = submissionFixture(), first = await submitInstalledShadow(input, paths, policy, 50)
  now += 100000
  vi.mocked(inspectInstalledShadowHost).mockClear().mockRejectedValue(new Error('unavailable'))
  expect((await submitInstalledShadow(input, paths, policy, 50)).id).toBe(first.id)
  await expect(submitInstalledShadow({ ...input, plan: { ...input.plan, subjectId: 'other' } }, paths, policy, 50)).rejects.toThrow('idempotency')
  expect(inspectInstalledShadowHost).not.toHaveBeenCalled()
})

it.each(['admission', 'window', 'cancel'])('does not queue after %s changes while opening admission', async (failure) => {
  const { owned, open, handle } = setup(), abort = new AbortController()
  open.mockImplementation(async () => {
    if (failure === 'window') now += 2000
    if (failure === 'cancel') abort.abort()
    if (failure === 'admission') owned.host.admit.mockImplementation(() => {
      throw new Error('binding changed')
    })
    return owned
  })
  await expect(submitInstalledShadow(submissionFixture(), paths, policy, 50, abort.signal)).rejects.toThrow()
  expect(db.prepare('SELECT count(*) AS n FROM biometric_shadow_runs').get()).toEqual({ n: 0 })
  expect(owned.close).toHaveBeenCalledOnce()
  expect(handle.close).toHaveBeenCalledOnce()
})
