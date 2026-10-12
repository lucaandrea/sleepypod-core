import { createHash } from 'node:crypto'
import { canonicalJson, canonicalWithLimit } from './canonical-json'
export { canonicalJson } from './canonical-json'

/** Same canonical encoding; larger bounded budget for retained rows/reports. */
export function dataHash(value: unknown): string {
  const encoded = canonicalWithLimit(value, 2000000, 32 * 1024 * 1024)
  return createHash('sha256').update(encoded).digest('hex')
}

export function configHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
