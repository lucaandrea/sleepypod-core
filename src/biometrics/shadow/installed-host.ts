import { guardShadowPythonInstallation } from './python-installation'
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type * as HostAPI from './host-entry'

type API = typeof HostAPI
const maximumBytes = 16 * 1024 * 1024
function signature(path: string) {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maximumBytes)) throw new Error('Invalid installed shadow host artifact')
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}
interface InstalledHost { path: string, signature: string, hostHash: string, api: API }
const state = globalThis as typeof globalThis & { __sleepypodInstalledShadowHostV1?: InstalledHost }

/** Trusted deployment path only. Load one exact release artifact per process;
 * changed installations require restart rather than reusing Node's stale cache.
 * This guards the Node bundle, not Python binaries or dependency wheel contents. */
export function loadInstalledShadowHost(hostPath: string) {
  const requestedPath = resolve(hostPath)
  signature(requestedPath) // reject a leaf symlink before canonicalizing parent paths
  const path = realpathSync(requestedPath)
  let cached = state.__sleepypodInstalledShadowHostV1
  if (cached) {
    if (cached.path !== path || signature(path) !== cached.signature) throw new Error('Installed shadow host changed; restart required')
  }
  else {
    const before = signature(path)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let hostHash: string
    try {
      const opened = fstatSync(fd, { bigint: true })
      if (`${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}` !== before) throw new Error('Shadow host changed before hashing')
      const digest = createHash('sha256'), buffer = Buffer.alloc(65536)
      let length = 0
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.length, null)
        if (!count) break
        length += count
        if (length > maximumBytes) throw new Error('Shadow host artifact exceeds its bound')
        digest.update(buffer.subarray(0, count))
      }
      hostHash = digest.digest('hex')
    }
    finally { closeSync(fd) }
    if (signature(path) !== before) throw new Error('Shadow host changed during hashing')
    const require = createRequire(path)
    if (require.cache[path]) throw new Error('Shadow host was loaded without installed identity verification')
    const api = require(path) as Partial<API>
    if (signature(path) !== before) throw new Error('Shadow host changed while loading')
    if (api.shadowHostApiVersion !== 'shadow-host-api-v1' || ['runProfiledShadowAttempt', 'openProfiledShadowHost', 'prepareShadowPlan', 'ShadowStore', 'shadowEngineBuildIdentity', 'readInstalledShadowQualifications']
      .some(name => typeof api[name as keyof API] !== 'function') || !api.shadowPlanSchema || !api.shadowStoragePolicySchema) throw new Error('Invalid installed shadow host API')
    cached = { path, signature: before, hostHash, api: api as API }
    state.__sleepypodInstalledShadowHostV1 = cached
  }
  const installed = cached
  return { api: installed.api, hostHash: installed.hostHash,
    assertCurrent: () => {
      if (signature(path) !== installed.signature || signature(requestedPath) !== installed.signature) throw new Error('Installed shadow host changed; restart required')
    } }
}

/** Probe through the loaded package and prove the fingerprint describes the
 * artifact actually loaded, including rechecking it after the async Python probe. */
export async function inspectInstalledShadowHost(hostPath: string, location: { pythonPath: string, modulesPath: string }, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Shadow build inspection cancelled')
  const target = { ...location }
  const loaded = loadInstalledShadowHost(hostPath)
  const build = await loaded.api.shadowEngineBuildIdentity(resolve(hostPath), target, signal)
  loaded.assertCurrent()
  if (build.identity.hostHash !== loaded.hostHash) throw new Error('Loaded shadow host differs from inspected artifact')
  const pythonCurrent = guardShadowPythonInstallation(target, build.python)
  const assertCurrent = () => {
    loaded.assertCurrent()
    pythonCurrent()
  }
  assertCurrent()
  return { ...loaded, build, assertCurrent }
}
