import { configHash } from '../algorithms/canonical'
import { defaultConfig, type BiometricConfig, type Override } from '../algorithms/registry'
import type { ProfileStore } from './store'

export function diffProfiles(store: ProfileStore, side: 'left' | 'right', revisionId: string | null, againstRevisionId: string | null) {
  const load = (id: string | null) => {
    if (id === null) return { resolved: defaultConfig, hash: configHash(defaultConfig), overrides: [] as Override[] }
    const validated = store.validateRevision(id, side)
    return { resolved: validated.resolved, hash: validated.hash, overrides: validated.revision.overrides as Override[] }
  }
  const before = load(againstRevisionId), after = load(revisionId)
  const changes: Array<{ path: string, before: unknown, after: unknown }> = []
  const walk = (left: unknown, right: unknown, path: string) => {
    if (configHash(left) === configHash(right)) return
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of Object.keys(left)) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
    }
    else changes.push({ path, before: left, after: right })
  }
  walk(before.resolved as BiometricConfig, after.resolved as BiometricConfig, '')
  const oldIntent = new Map(before.overrides.map(row => [row.path, row.value]))
  const newIntent = new Map(after.overrides.map(row => [row.path, row.value]))
  const intentChangedPaths = [...new Set([...oldIntent.keys(), ...newIntent.keys()])].filter(path =>
    !oldIntent.has(path) || !newIntent.has(path) || configHash(oldIntent.get(path)) !== configHash(newIntent.get(path)))
  return { revisionId, againstRevisionId, beforeHash: before.hash, afterHash: after.hash, changes, intentChangedPaths }
}
