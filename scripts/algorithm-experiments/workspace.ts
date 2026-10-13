import Database from 'better-sqlite3'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { publishJson } from './files'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const workspacePolicySchema = z.object({
  maximumReportBytes: integer.positive().max(64 * 1024 ** 3),
  maximumReportFiles: integer.positive().max(100000),
  maximumSingleReportBytes: integer.positive().max(32 * 1024 ** 2),
  maximumDatabaseBytes: integer.min(65536).max(1024 ** 3),
  minimumFreeBytes: integer.max(1024 ** 4),
}).strict()
/** Off-pod workstation limits, not pod production budgets. */
export const defaultWorkspacePolicy = Object.freeze({ maximumReportBytes: 1024 ** 3, maximumReportFiles: 2048,
  maximumSingleReportBytes: 32 * 1024 ** 2, maximumDatabaseBytes: 64 * 1024 ** 2, minimumFreeBytes: 1024 ** 3 })

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Experiment workspace must be private and owned')
}
async function privateFile(path: string, missing = false) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077)
      || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe experiment workspace file')
    return info
  }
  catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** A separate SQLite write lock survives async work and is released by the OS
 * on controller death. Never remove its inode or steal ownership by timeout. */
export async function withExperimentWorkspace<T>(directory: string, rawPolicy: unknown,
  action: (workspace: { reports: string, configureDatabase: (db: Database.Database) => void, publishReport: typeof publishJson, checkCapacity: () => Promise<void> }) => Promise<T>) {
  const policy = workspacePolicySchema.parse(rawPolicy), root = resolve(directory)
  await privateDirectory(root)
  const lockPath = join(root, '.writer.sqlite')
  try {
    const file = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await file.close()
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const info = await privateFile(lockPath + suffix, suffix !== '')
    if (info && info.size > 65536) throw new Error('Workspace lock exceeds its size bound')
  }
  const lock = new Database(lockPath, { timeout: 0 })
  let publication: Promise<void> = Promise.resolve()
  try {
    lock.exec('BEGIN IMMEDIATE')
    if ((lock.prepare('SELECT COUNT(*) AS count FROM sqlite_master').get() as { count: number }).count !== 0) throw new Error('Unexpected workspace lock database')
    const reports = join(root, 'reports')
    await privateDirectory(reports)
    const capacity = async (additionalBytes = 0, additionalFiles = 0) => {
      let count = additionalFiles, bytes = additionalBytes
      const entries = await opendir(reports)
      for await (const entry of entries) {
        if (++count > policy.maximumReportFiles) throw new Error('Experiment report file quota exceeded')
        const info = await privateFile(join(reports, entry.name))
        bytes += info?.size ?? 0
        if (bytes > policy.maximumReportBytes) throw new Error('Experiment report byte quota exceeded')
      }
      if (count > policy.maximumReportFiles || bytes > policy.maximumReportBytes) throw new Error('Experiment report quota exceeded')
      const disk = await statfs(root, { bigint: true })
      // Reserve for a complete rollback journal and growth of the bounded ledger.
      const required = BigInt(policy.minimumFreeBytes) + BigInt(2 * policy.maximumDatabaseBytes) + BigInt(additionalBytes)
      if (disk.bavail < 0n || disk.bsize <= 0n || disk.bavail * disk.bsize < required) throw new Error('Experiment workspace free-space reserve unavailable')
    }
    await capacity()
    return await action({ reports, checkCapacity: () => capacity(), configureDatabase: (db) => {
      const pageSize = Number(db.pragma('page_size', { simple: true }))
      if (!Number.isSafeInteger(pageSize) || pageSize < 512) throw new Error('Invalid experiment database page size')
      const pages = Math.floor(policy.maximumDatabaseBytes / pageSize)
      if (Number(db.pragma(`max_page_count = ${pages}`, { simple: true })) > pages) throw new Error('Experiment database quota exceeded')
      if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Bounded experiment rollback journal required')
    }, publishReport: async (path, value) => {
      if (dirname(resolve(path)) !== reports) throw new Error('Report path outside managed workspace')
      const snapshot = structuredClone(value)
      const bytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2) + '\n')
      if (bytes > policy.maximumSingleReportBytes) throw new Error('Experiment single-report quota exceeded')
      const result = publication.then(async () => {
        await capacity(bytes, 1)
        await publishJson(path, snapshot)
      })
      publication = result.catch(() => {})
      return result
    } })
  }
  finally {
    await publication
    lock.close()
  }
}
