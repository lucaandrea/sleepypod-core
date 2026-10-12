import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ReferenceInputError } from '../references/time'

export const REPORT_BUDGET_BYTES = 64 * 1024 * 1024
export const MAX_REPORT_BYTES = 16 * 1024 * 1024
export const reportArtifactSchema = z.object({ kind: z.literal('biometric-report-artifact-v1'),
  name: z.string().regex(/^[a-f0-9-]{36}\.[1-9][0-9]*\.[a-f0-9]{64}\.json$/),
  byteLength: z.number().int().positive().max(MAX_REPORT_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ReportArtifact = z.infer<typeof reportArtifactSchema>
const ownedName = /^[a-f0-9-]{36}\.[1-9][0-9]*\.[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/

/** Trusted evaluator artifacts only. The root comes from the server's DB path,
 * never a request. Files are immutable; a fenced DB transaction publishes the
 * descriptor only after fsync + atomic rename. Failed publication leaves an
 * unreferenced artifact for bounded cleanup, never a partially visible result. */
export class ReportArtifactStore {
  private publishing = false
  constructor(private readonly root: string) {}

  /** A separate SQLite file provides an OS-released cross-process lock. Long
   * file writes never hold the live biometrics DB transaction. All publishers
   * and collectors take this lock before reading live descriptor/quota state. */
  withPublication<T>(operation: () => T): T {
    if (this.publishing) return operation()
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const lock = new Database(join(this.root, '.publication.sqlite'), { timeout: 1000 })
    try {
      return lock.transaction(() => {
        this.publishing = true
        try {
          return operation()
        }
        finally {
          this.publishing = false
        }
      }).immediate()
    }
    finally {
      lock.close()
    }
  }

  usage() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const names = readdirSync(this.root)
    if (names.length > 4096) throw new ReferenceInputError('RESOURCE_LIMIT', 'Too many report artifacts')
    let bytes = 0
    for (const name of names) {
      if (!ownedName.test(name)) continue
      const stat = lstatSync(join(this.root, name))
      if (!stat.isFile()) throw new ReferenceInputError('RESULT_CORRUPT', 'Unexpected report artifact type')
      bytes += stat.size
    }
    return bytes
  }

  write(jobId: string, token: number, serialized: string, inlineBytes: number): ReportArtifact {
    return this.withPublication(() => {
      z.string().uuid().parse(jobId)
      z.number().int().positive().parse(token)
      z.number().int().nonnegative().parse(inlineBytes)
      const byteLength = Buffer.byteLength(serialized)
      if (!byteLength || byteLength > MAX_REPORT_BYTES) throw new ReferenceInputError('RESOURCE_LIMIT', 'Report exceeds 16 MiB')
      const sha256 = createHash('sha256').update(serialized).digest('hex')
      const name = `${jobId}.${token}.${sha256}.json`
      const descriptor = reportArtifactSchema.parse({ kind: 'biometric-report-artifact-v1', name, byteLength, sha256 })
      const used = this.usage()
      try {
        const stat = lstatSync(join(this.root, name))
        if (stat.isFile() && stat.size === byteLength) {
          const bytes = readFileSync(join(this.root, name))
          if (createHash('sha256').update(bytes).digest('hex') === sha256) {
            if (used + inlineBytes > REPORT_BUDGET_BYTES) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reports reached the 64 MiB storage budget')
            return descriptor
          }
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (used + byteLength + inlineBytes > REPORT_BUDGET_BYTES) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reports reached the 64 MiB storage budget')
      const temporary = join(this.root, `${name}.${randomUUID()}.tmp`)
      let fd: number | undefined
      try {
        fd = openSync(temporary, 'wx', 0o600)
        writeFileSync(fd, serialized)
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        renameSync(temporary, join(this.root, name))
        const directory = openSync(this.root, 'r')
        try {
          fsyncSync(directory)
        }
        finally {
          closeSync(directory)
        }
        return descriptor
      }
      finally {
        if (fd !== undefined) closeSync(fd)
        try {
          unlinkSync(temporary)
        }
        catch { /* Atomic rename or cleanup after a failed write. */ }
      }
    })
  }

  read(raw: unknown): unknown {
    const parsed = reportArtifactSchema.safeParse(raw)
    if (!parsed.success) throw new ReferenceInputError('RESULT_CORRUPT', 'Invalid report artifact descriptor')
    const descriptor = parsed.data
    try {
      const path = join(this.root, descriptor.name)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size !== descriptor.byteLength) throw new Error('Artifact size/type mismatch')
      const bytes = readFileSync(path)
      if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Artifact hash mismatch')
      return JSON.parse(bytes.toString('utf8'))
    }
    catch {
      throw new ReferenceInputError('RESULT_CORRUPT', 'Report artifact is missing or corrupt')
    }
  }

  /** Called only after the descriptor has been detached in a committed DB
   * transaction under the publication lock. Failed unlink remains GC work. */
  removeReleased(raw: ReportArtifact) {
    const descriptor = reportArtifactSchema.parse(raw)
    if (!this.publishing) throw new Error('Artifact release requires the publication lock')
    try {
      unlinkSync(join(this.root, descriptor.name))
    }
    catch { /* Retained orphan remains counted against the filesystem quota. */ }
  }

  /** Protect freshly staged files from a concurrent publisher. Only files
   * outside the committed descriptor set and older than one hour are removed. */
  collect(referenced: ReadonlySet<string>, now = Date.now()) {
    return this.withPublication(() => {
      this.usage()
      let removed = 0
      for (const name of readdirSync(this.root)) {
        if (!ownedName.test(name) || referenced.has(name)) continue
        const path = join(this.root, name)
        const stat = lstatSync(path)
        if (stat.isFile() && now - stat.mtimeMs > 3600000) {
          unlinkSync(path)
          removed++
        }
      }
      return removed
    })
  }
}
