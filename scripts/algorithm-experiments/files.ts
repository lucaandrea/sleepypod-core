import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { algorithmPackageManifestSchema, maximumPackageBytes, verifyAlgorithmPackage } from '../../src/biometrics/packages/manifest'

function openRegular(path: string, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error('Invalid file byte limit')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Expected a bounded regular file')
    return fd
  }
  catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Symlinks, devices and FIFOs are never followed. Size is checked both before
 * and during reads so a growing input cannot bypass its transport limit. */
export function* readJsonLines(path: string, maximumBytes: number, maximumLineBytes = 8 * 1024 * 1024) {
  const fd = openRegular(path, maximumBytes)
  const chunk = Buffer.alloc(65536)
  let total = 0, pending = Buffer.alloc(0)
  try {
    let count: number
    while ((count = readSync(fd, chunk)) !== 0) {
      total += count
      if (total > maximumBytes) throw new Error('File byte limit exceeded')
      pending = Buffer.concat([pending, chunk.subarray(0, count)])
      let newline: number
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > maximumLineBytes) throw new Error('JSON line byte limit exceeded')
        const line = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        if (!line.length) throw new Error('Empty JSON line')
        yield JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown
      }
      if (pending.length > maximumLineBytes) throw new Error('JSON line byte limit exceeded')
    }
    if (pending.length) yield JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending)) as unknown
  }
  finally { closeSync(fd) }
}

export function readJsonFile(path: string, maximumBytes: number): unknown {
  const fd = openRegular(path, maximumBytes)
  try {
    const bytes = Buffer.alloc(maximumBytes + 1)
    let offset = 0, count: number
    while ((count = readSync(fd, bytes, offset, bytes.length - offset, null)) !== 0) {
      offset += count
      if (offset > maximumBytes) throw new Error('File byte limit exceeded')
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)))
  }
  finally { closeSync(fd) }
}

const proposalSchema = z.object({ schema: z.literal('biometric-package-proposal-v1'), manifest: algorithmPackageManifestSchema,
  files: z.array(z.object({ path: z.string().min(1).max(240), base64: z.string().max(Math.ceil(maximumPackageBytes / 3) * 4) }).strict()).max(128),
}).strict()

/** A single inert JSON envelope avoids archive extraction and filesystem paths
 * derived from candidate data. Every byte is verified against the manifest. */
export function readPackageProposal(path: string) {
  const proposal = proposalSchema.parse(readJsonFile(path, 48 * 1024 * 1024))
  if (new Set(proposal.files.map(file => file.path)).size !== proposal.files.length) throw new Error('Duplicate proposal file')
  const files = new Map<string, Buffer>()
  let total = 0
  for (const file of proposal.files) {
    const bytes = Buffer.from(file.base64, 'base64')
    if (bytes.toString('base64') !== file.base64) throw new Error('Expected canonical base64')
    total += bytes.length
    if (total > maximumPackageBytes) throw new Error('Proposal byte limit exceeded')
    files.set(file.path, bytes)
  }
  const verified = verifyAlgorithmPackage(proposal.manifest, files)
  return { ...verified, files }
}

/** Publish only complete JSON, mode 0600, and never replace an existing report.
 * Hard-link publication is atomic and refuses existing files or symlinks. */
export async function publishJson(path: string, value: unknown) {
  const staging = `${path}.${randomUUID()}.tmp`
  const file = await open(staging, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n')
    await file.sync()
    await file.close()
    await link(staging, path)
  }
  finally {
    await file.close()
    await unlink(staging)
  }
}
