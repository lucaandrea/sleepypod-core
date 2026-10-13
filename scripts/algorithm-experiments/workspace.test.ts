// @vitest-environment node
import Database from 'better-sqlite3'
import * as filesystem from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withExperimentWorkspace } from './workspace'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof filesystem>()
  return { ...actual, statfs: vi.fn(actual.statfs) }
})

let root: string
const policy = { maximumReportBytes: 80, maximumReportFiles: 2, maximumSingleReportBytes: 60,
  maximumDatabaseBytes: 65536, minimumFreeBytes: 0 }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'experiment-workspace-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
it('rejects concurrent workspace owners and releases on ordinary failure', async () => {
  await withExperimentWorkspace(root, policy, async () => {
    await expect(withExperimentWorkspace(root, policy, async () => null)).rejects.toThrow('locked')
  })
  await expect(withExperimentWorkspace(root, policy, async () => {
    throw new Error('failed')
  })).rejects.toThrow('failed')
  expect(await withExperimentWorkspace(root, policy, async () => 'available')).toBe('available')
})
it('bounds report bytes/counts before publication without deleting prior evidence', async () => {
  await withExperimentWorkspace(root, policy, async (workspace) => {
    await workspace.publishReport(join(workspace.reports, 'first.json'), { value: 'a'.repeat(30) })
    await expect(workspace.publishReport(join(workspace.reports, 'second.json'), { value: 'b'.repeat(30) })).rejects.toThrow('byte quota')
    await expect(workspace.publishReport(join(workspace.reports, 'oversize.json'), { value: 'c'.repeat(60) })).rejects.toThrow('single-report')
    await workspace.publishReport(join(workspace.reports, 'small.json'), {})
    await expect(workspace.publishReport(join(workspace.reports, 'third.json'), {})).rejects.toThrow('file quota')
    expect((await readdir(workspace.reports)).sort()).toEqual(['first.json', 'small.json'])
    await expect(workspace.publishReport(join(root, 'outside.json'), {})).rejects.toThrow('outside')
  })
})
it('refuses unsafe existing report entries and a symlinked lock', async () => {
  await withExperimentWorkspace(root, policy, async (workspace) => {
    await symlink('/tmp', join(workspace.reports, 'link'))
    await expect(workspace.checkCapacity()).rejects.toThrow('Unsafe')
  })
  await rm(join(root, '.writer.sqlite'))
  await symlink('/tmp', join(root, '.writer.sqlite'))
  await expect(withExperimentWorkspace(root, policy, async () => null)).rejects.toThrow('Unsafe')
})
it('enforces the ledger page ceiling and refuses a reduced limit below existing size', async () => {
  const db = new Database(join(root, 'experiments.sqlite'))
  try {
    await withExperimentWorkspace(root, policy, async (workspace) => {
      workspace.configureDatabase(db)
      db.exec('CREATE TABLE payload(bytes BLOB)')
      expect(() => db.prepare('INSERT INTO payload VALUES (?)').run(Buffer.alloc(100000))).toThrow(/full/)
      expect(db.prepare('SELECT COUNT(*) AS count FROM payload').get()).toEqual({ count: 0 })
    })
    db.pragma('max_page_count = 1000')
    db.prepare('INSERT INTO payload VALUES (?)').run(Buffer.alloc(100000))
    await expect(withExperimentWorkspace(root, policy, async workspace => workspace.configureDatabase(db))).rejects.toThrow('database quota')
  }
  finally { db.close() }
})
it('fails admission before starting work when the free-space reserve is unavailable', async () => {
  vi.mocked(filesystem.statfs).mockResolvedValueOnce({ type: 0n, bsize: 4096n, blocks: 1n, bfree: 0n, bavail: 0n, files: 0n, ffree: 0n })
  let entered = false
  await expect(withExperimentWorkspace(root, { ...policy, minimumFreeBytes: 1024 ** 4 }, async () => {
    entered = true
  })).rejects.toThrow('free-space')
  expect(entered).toBe(false)
})
it('releases the OS writer lock after the owning controller is killed', async () => {
  await writeFile(join(root, '.writer.sqlite'), '', { mode: 0o600 })
  const child = spawn(process.execPath, ['-e', `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.send('locked');setInterval(()=>{},1000)`, join(root, '.writer.sqlite')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const closed = once(child, 'close')
  try {
    await once(child, 'message')
    await expect(withExperimentWorkspace(root, policy, async () => null)).rejects.toThrow('locked')
    child.kill('SIGKILL')
    await closed
    expect(await withExperimentWorkspace(root, policy, async () => 'recovered')).toBe('recovered')
  }
  finally {
    child.kill('SIGKILL')
    await closed
  }
})

it('serializes concurrent publications under the same quota snapshot', async () => {
  await withExperimentWorkspace(root, policy, async (workspace) => {
    const first = workspace.publishReport(join(workspace.reports, 'first.json'), { value: 'a'.repeat(30) })
    const second = workspace.publishReport(join(workspace.reports, 'second.json'), { value: 'b'.repeat(30) })
    const results = await Promise.allSettled([first, second])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await readdir(workspace.reports)).toEqual(['first.json'])
  })
})
