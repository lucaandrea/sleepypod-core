import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const prefix = 'org.sleepypod.experiment'
const owner = `${process.getuid?.() ?? 'unknown'}`
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const namePattern = new RegExp(`^/sleepypod-(experiment|environment)-${uuid}$`)

/** Immutable Docker labels survive a terminated controller. Leave two minutes
 * beyond the hard deadline for startup, measurement and ordinary cleanup. */
export function recoveryLabels(kind: 'experiment' | 'environment', maximumWallMs: number, now = Date.now()) {
  if (!Number.isSafeInteger(maximumWallMs) || maximumWallMs <= 0 || maximumWallMs > 3600000
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(now + maximumWallMs + 120000)) throw new Error('Invalid recovery deadline')
  return { [`${prefix}.version`]: '1', [`${prefix}.owner`]: owner,
    [`${prefix}.kind`]: kind, [`${prefix}.expires`]: String(now + maximumWallMs + 120000) }
}
export function recoveryLabelArguments(kind: 'experiment' | 'environment', maximumWallMs: number) {
  return Object.entries(recoveryLabels(kind, maximumWallMs)).flatMap(([key, value]) => ['--label', `${key}=${value}`])
}

/** Fail closed on malformed metadata; names alone never establish ownership. */
export function expiredOwnedContainer(raw: unknown, now: number): string | null {
  if (!Number.isSafeInteger(now) || now < 0 || !raw || typeof raw !== 'object') return null
  const value = raw as { Id?: unknown, Name?: unknown, Config?: { Labels?: Record<string, unknown> } }
  if (typeof value.Id !== 'string' || !/^[a-f0-9]{64}$/.test(value.Id)
    || typeof value.Name !== 'string' || !namePattern.test(value.Name)) return null
  const labels = value.Config?.Labels
  if (!labels || labels[`${prefix}.version`] !== '1' || labels[`${prefix}.owner`] !== owner) return null
  const kind = value.Name.startsWith('/sleepypod-experiment-') ? 'experiment' : 'environment'
  if (labels[`${prefix}.kind`] !== kind) return null
  const expires = labels[`${prefix}.expires`]
  if (typeof expires !== 'string' || !/^[1-9][0-9]{0,15}$/.test(expires)
    || !Number.isSafeInteger(Number(expires)) || Number(expires) > now) return null
  return value.Id
}

/** Operates only on the selected Docker daemon and the invoking host UID.
 * Remove by inspected immutable ID, never by a reusable container name. */
export async function recoverExpiredContainers(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid recovery time')
  const { stdout } = await exec('docker', ['ps', '-aq', '--no-trunc', '--filter', `label=${prefix}.version=1`,
    '--filter', `label=${prefix}.owner=${owner}`], { timeout: 10000, maxBuffer: 1024 * 1024 })
  const ids = stdout.trim() ? stdout.trim().split(/\s+/) : []
  if (ids.length > 4096 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid recovery inventory')
  const removed: string[] = []
  for (const id of ids) {
    let inspection
    try {
      inspection = await exec('docker', ['inspect', '--type', 'container', id], { timeout: 10000, maxBuffer: 1024 * 1024 })
    }
    catch (error) {
      if (error instanceof Error && /No such (object|container):/.test(error.message)) continue
      throw error
    }
    const values: unknown = JSON.parse(inspection.stdout)
    if (!Array.isArray(values) || values.length !== 1 || expiredOwnedContainer(values[0], now) !== id) continue
    try {
      await exec('docker', ['rm', '-f', id], { timeout: 10000, maxBuffer: 65536 })
      removed.push(id)
    }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('No such container:')) throw error
    }
  }
  return { schema: 'biometric-container-recovery-v1' as const, checkedAt: now, inspected: ids.length, removed }
}
