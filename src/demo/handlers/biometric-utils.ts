import { canonicalJson, canonicalWithLimit } from '@/src/biometrics/algorithms/canonical-json'

/** Real canonical SHA-256, with no Node modules in the browser demo bundle. */
export async function hash(value: unknown): Promise<string> {
  return hashText(canonicalJson(value))
}
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function dataHash(value: unknown) {
  return hashText(canonicalWithLimit(value, 2000000, 32 * 1024 * 1024))
}
