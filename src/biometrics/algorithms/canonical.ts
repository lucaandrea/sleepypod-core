import { createHash } from 'node:crypto'

/**
 * finite-binary64-json-v1: sorted UTF-16 keys, ordered arrays, exact decimal
 * expansion of each finite IEEE-754 number, negative zero normalized to zero.
 * Exact expansion avoids differences between Python and JS float printers.
 * This is valid numeric JSON, not RFC 8785. Version it in every manifest.
 */
function numberToken(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite JSON number')
  if (value === 0) return '0'
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, Math.abs(value))
  const bits = view.getBigUint64(0)
  const exponent = Number((bits >> 52n) & 2047n)
  let coefficient = bits & ((1n << 52n) - 1n)
  if (exponent !== 0) coefficient += 1n << 52n
  const power = (exponent || 1) - 1023 - 52
  let token: string
  if (power >= 0) token = (coefficient << BigInt(power)).toString()
  else {
    const places = -power
    const digits = (coefficient * 5n ** BigInt(places)).toString().padStart(places + 1, '0')
    token = `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/0+$/, '').replace(/\.$/, '')
  }
  return value < 0 ? `-${token}` : token
}

export function canonicalJson(value: unknown): string {
  let nodes = 0
  function visit(item: unknown, depth: number): string {
    if (++nodes > 20000 || depth > 32) throw new Error('JSON resource limit')
    if (item === null) return 'null'
    if (typeof item === 'number') return numberToken(item)
    if (typeof item === 'boolean') return String(item)
    if (typeof item === 'string') {
      if (item.length > 65536 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) throw new Error('Invalid JSON string')
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) return `[${Array.from(item, child => visit(child, depth + 1)).join(',')}]`
    if (typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return `{${Object.keys(item).sort().map(key => `${visit(key, depth + 1)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
    }
    throw new Error('Expected finite JSON data')
  }
  return visit(value, 0)
}

export function configHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
