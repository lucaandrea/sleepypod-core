import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { configHash } from '../algorithms/canonical'
import { shadowPythonBuildSchema } from './build'

const maximumBytes = 16 * 1024 * 1024
function signature(path: string) {
  const stat = lstatSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

/** Capture known source and dependency metadata artifacts after the Python
 * probe, validating their content against that probe before retaining cheap
 * synchronous file-identity checks. Does not attest every installed binary. */
export function guardShadowPythonInstallation(location: { pythonPath: string, modulesPath: string }, rawBuild: unknown) {
  const build = shadowPythonBuildSchema.parse(rawBuild)
  if (configHash(build.identity) !== build.hash) throw new Error('Shadow Python build integrity mismatch')
  const files: { path: string, hash: string, metadata: boolean }[] = []
  for (const [relative, hash] of Object.entries(build.identity.sources)) {
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Python source identity path')
    files.push({ path: resolve(location.modulesPath, relative), hash, metadata: false })
  }
  for (const name of ['numpy', 'scipy'] as const) {
    for (const kind of ['record', 'wheel'] as const) {
      const path = build.dependencyFiles[name][kind]
      if (!isAbsolute(path)) throw new Error('Dependency metadata path must be absolute')
      files.push({ path, hash: build.identity.dependencies[name][`${kind}_sha256`], metadata: true })
    }
  }
  const watched: { path: string, canonical: string, requestedSignature: string, canonicalSignature: string }[] = []
  const watch = (path: string) => {
    const requestedSignature = signature(path), canonical = realpathSync(path), canonicalSignature = signature(canonical)
    watched.push({ path, canonical, requestedSignature, canonicalSignature })
    return canonical
  }
  const assertCurrent = () => {
    for (const file of watched) {
      if (signature(file.path) !== file.requestedSignature || realpathSync(file.path) !== file.canonical
        || signature(file.canonical) !== file.canonicalSignature) throw new Error('Shadow Python installation changed')
    }
  }
  for (const file of files) {
    const canonical = watch(file.path), fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Invalid Python identity artifact')
      const buffer = Buffer.alloc(65536), chunks: Buffer[] = []
      let length = 0
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.length, null)
        if (!count) break
        length += count
        if (length > maximumBytes) throw new Error('Python identity artifact exceeds its bound')
        chunks.push(Buffer.from(buffer.subarray(0, count)))
      }
      const bytes = Buffer.concat(chunks, length)
      const content = file.metadata ? new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n') : bytes
      if (createHash('sha256').update(content).digest('hex') !== file.hash) throw new Error('Python identity artifact differs from probe')
    }
    finally { closeSync(fd) }
  }
  watch(resolve(location.pythonPath)) // interpreter links and target replacement
  assertCurrent()
  return assertCurrent
}
