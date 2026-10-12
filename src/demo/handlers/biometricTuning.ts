import { biometricManifest, defaultConfig, resolveOverrides } from '@/src/biometrics/algorithms/registry-core'
import { canonicalJson } from '@/src/biometrics/algorithms/canonical-json'
import type { DemoHandlers, RouterOutputs } from '../types'

type Revision = RouterOutputs['biometricTuning']['getProfileRevision']
const revisions: Revision[] = []
const requests = new Map<string, { fingerprint: string, revision: Revision }>()

/** Real canonical SHA-256, with no Node modules in the browser demo bundle. */
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const getRevision = (id: string) => {
  const revision = revisions.find(row => row.id === id)
  if (!revision) throw new Error('NOT_FOUND: demo profile revision')
  return structuredClone(revision)
}
async function resolve(overrides: Parameters<typeof resolveOverrides>[0], baseManifestHash?: string) {
  const manifestHash = await hash(biometricManifest)
  if (baseManifestHash !== undefined && baseManifestHash !== manifestHash) throw new Error('PROFILE_INCOMPATIBLE: unknown base manifest')
  const result = resolveOverrides(overrides)
  return { ...result, hash: await hash(result.resolved), manifestHash }
}

export const biometricTuning: DemoHandlers<'biometricTuning'> = {
  getManifest: async () => ({ manifest: biometricManifest, manifestHash: await hash(biometricManifest), activationAvailable: false }),
  resolveProfile: input => resolve(input.overrides, input.baseManifestHash),
  createProfileRevision: async (input) => {
    const result = await resolve(input.overrides, input.baseManifestHash)
    const fingerprint = await hash({ ...input, baseManifestHash: result.manifestHash })
    const key = input.idempotencyKey
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT: demo profile request changed')
      return structuredClone(previous.revision)
    }
    const parent = input.parentRevisionId ? getRevision(input.parentRevisionId) : null
    if (parent && parent.side !== input.side) throw new Error('PROFILE_INCOMPATIBLE: wrong side')
    const familyId = parent?.familyId ?? uuid()
    const revision: Revision = { ...input, id: uuid(), familyId, revision: 1 + Math.max(0, ...revisions.filter(row => row.familyId === familyId).map(row => row.revision)),
      baseManifestHash: result.manifestHash, baseManifest: biometricManifest, resolved: result.resolved, resolvedHash: result.hash,
      dependencyHashes: biometricManifest.dependencyHashes, parentRevisionId: parent?.id ?? null, requestHash: fingerprint, createdAtMs: Date.now() }
    revisions.unshift(revision)
    requests.set(key, { fingerprint, revision })
    return structuredClone(revision)
  },
  getProfileRevision: input => getRevision(input.id),
  listProfileRevisions: (input) => {
    const rows = revisions.filter(row => row.side === input.side && (!input.familyId || row.familyId === input.familyId)
      && (input.beforeCreatedAtMs === undefined || row.createdAtMs < input.beforeCreatedAtMs || (row.createdAtMs === input.beforeCreatedAtMs && row.id < (input.beforeId ?? ''))))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
    const items = rows.slice(0, 100), last = items[items.length - 1]
    return { items: structuredClone(items), nextCursor: rows.length > 100 && last ? { id: last.id, createdAtMs: last.createdAtMs } : null }
  },
  validateProfileRevision: async (input) => {
    const revision = getRevision(input.id)
    if (revision.side !== input.side) throw new Error('PROFILE_INCOMPATIBLE: wrong side')
    const result = await resolve(revision.overrides, revision.baseManifestHash)
    return { id: revision.id, resolvedHash: result.hash, compatible: true, evidence: 'not_checked', limitations: ['Demo profile; no biological validation or hardware activation.'] }
  },
  getProfileOverview: async ({ side }) => {
    const resolved = await resolve([])
    return { desired: { binding: { side, generation: 0, desiredRevisionId: null, previousRevisionId: null, updatedAtMs: 0 }, resolved: defaultConfig, hash: resolved.hash, isDefault: true, warning: null },
      stageView: { classifier: defaultConfig.sleep_stages, isDefault: true, provenance: { interpretation: 'current_classifier_view', source: 'demo', generation: null, revisionId: null, bundleHash: resolved.hash, stageHash: await hash(defaultConfig.sleep_stages), manifestHash: resolved.manifestHash, effectiveSampleTimeMs: null, warning: 'Demo data; no live processor.' } },
      legacyStageView: { classifier: defaultConfig.sleep_stages, personalized: false, migrationPending: false },
      runtimeHealth: { state: 'unreported', staleAfterMs: 120000, components: [] }, runtimeStatus: 'unreported', receipts: [], sensorCalibration: [], activationAvailable: false,
      limitations: ['Demo data; no live processor or hardware activation.'] }
  },
  listActivationHistory: () => ({ items: [], nextGeneration: null }),
}
