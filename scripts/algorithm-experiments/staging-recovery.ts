import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, opendir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const exec = promisify(execFile)
const marker = '.sleepypod-staging.json'
const directoryName = /^sleepypod-package-[a-zA-Z0-9]{6}$/
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const receiptSchema = z.object({ schema: z.literal('biometric-private-staging-v1'),
  directory: z.string().regex(directoryName), device: integer, inode: integer, owner: integer,
  controllerPid: integer.positive().max(2147483647), expiresAtMs: integer,
  containerName: z.string().regex(/^sleepypod-experiment-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
}).strict()

/** Written before input/package bytes. Legacy unmarked directories are never
 * inferred to be owned from a matching name alone. */
export async function recordExperimentStaging(root: string, containerName: string, maximumWallMs: number, now = Date.now()) {
  z.number().int().min(1).max(3600000).parse(maximumWallMs)
  integer.parse(now)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new Error('Staging directory must be private and owned')
  const receipt = receiptSchema.parse({ schema: 'biometric-private-staging-v1', directory: basename(root), device: info.dev, inode: info.ino,
    owner: info.uid, controllerPid: process.pid, expiresAtMs: now + maximumWallMs + 120000, containerName })
  const file = await open(join(root, marker), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(JSON.stringify(receipt))
    await file.sync()
  }
  finally { await file.close() }
}
function processAbsent(pid: number) {
  try {
    process.kill(pid, 0)
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  return false
}
async function containerAbsent(name: string) {
  try {
    await exec('docker', ['inspect', '--type', 'container', name], { timeout: 10000, maxBuffer: 1024 * 1024 })
    return false
  }
  catch (error) {
    if (error instanceof Error && /No such (object|container):/.test(error.message)) return true
    throw error // An unavailable daemon is not proof of absence.
  }
}
/** Trusted host entry point; base is injectable for isolated tests. Container
 * recovery must run first. Only an expired receipt, dead controller and absent
 * named container permit deletion. PID reuse conservatively retains a directory. */
export async function recoverExperimentStaging(now = Date.now(), base = tmpdir()) {
  integer.parse(now)
  const removed: string[] = []
  let scanned = 0, candidates = 0
  const entries = await opendir(base)
  for await (const entry of entries) {
    if (++scanned > 16384) throw new Error('Staging recovery inventory exceeds limit')
    if (!directoryName.test(entry.name)) continue
    if (++candidates > 128) throw new Error('Staging recovery candidate limit exceeded')
    const root = join(base, entry.name)
    let before, receipt, markerIdentity
    try {
      before = await lstat(root)
      if (!before.isDirectory() || before.isSymbolicLink() || before.mode & 0o077 || before.uid !== process.getuid?.()) continue
      const file = await open(join(root, marker), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        markerIdentity = await file.stat()
        if (!markerIdentity.isFile() || markerIdentity.nlink !== 1 || markerIdentity.mode & 0o077 || markerIdentity.uid !== before.uid || markerIdentity.size > 4096) continue
        const bytes = Buffer.alloc(4097)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== markerIdentity.size) continue
        receipt = receiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))))
      }
      finally { await file.close() }
    }
    catch { continue } // Unknown or damaged ownership never authorizes deletion.
    if (receipt.directory !== entry.name || receipt.device !== before.dev || receipt.inode !== before.ino || receipt.owner !== before.uid
      || receipt.expiresAtMs > now || !processAbsent(receipt.controllerPid)) continue
    if (!await containerAbsent(receipt.containerName)) continue
    let current, currentMarker
    try {
      current = await lstat(root)
      currentMarker = await lstat(join(root, marker))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode || current.uid !== before.uid
      || currentMarker.dev !== markerIdentity.dev || currentMarker.ino !== markerIdentity.ino || currentMarker.size !== markerIdentity.size
      || currentMarker.mtimeMs !== markerIdentity.mtimeMs || !processAbsent(receipt.controllerPid)) continue
    try {
      await rm(root, { recursive: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    removed.push(entry.name)
  }
  return { schema: 'biometric-staging-recovery-v1' as const, checkedAt: now, scanned, candidates, removed }
}
