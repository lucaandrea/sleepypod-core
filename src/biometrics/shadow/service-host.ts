import { dataHash } from '../algorithms/canonical'
import { runInstalledShadowAttempt, reconcileInstalledShadowRuns, pendingInstalledShadowRun } from './installed-attempt'
import { shadowStoragePolicySchema } from './store'
import { ShadowService } from './service'

interface InstallationOptions {
  installation: Parameters<typeof runInstalledShadowAttempt>[2]
  storagePolicy: unknown
  busyTimeoutMs: number
  recoveryIntervalMs: number
  recoveryMaximumRuns: number
}
const shared = globalThis as typeof globalThis & {
  __biometricShadowService?: { service: ShadowService, configurationHash: string }
}

/** Explicit deployment configuration only; no unqualified execution defaults. */
export function startShadowService(raw: InstallationOptions) {
  const options = structuredClone(raw)
  options.storagePolicy = shadowStoragePolicySchema.parse(options.storagePolicy)
  if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 1 || options.busyTimeoutMs > 1000) throw new Error('Invalid shadow database timeout')
  const configurationHash = dataHash(options)
  const existing = shared.__biometricShadowService
  if (existing) {
    if (existing.configurationHash !== configurationHash) throw new Error('Shadow service configuration changed; restart required')
    return existing.service
  }
  const service = new ShadowService({
    recoveryIntervalMs: options.recoveryIntervalMs,
    recoveryMaximumRuns: options.recoveryMaximumRuns,
    recover: cursor => reconcileInstalledShadowRuns(options.installation, options.storagePolicy, options.busyTimeoutMs, cursor),
    pending: cursor => pendingInstalledShadowRun(options.installation, options.storagePolicy, options.busyTimeoutMs, cursor),
    execute: (runId, revisionId, signal) => runInstalledShadowAttempt(runId, revisionId, options.installation,
      options.storagePolicy, options.busyTimeoutMs, signal),
    onRecoveryError: () => console.warn('[biometrics] Shadow recovery failed; service will retry'),
    onExecutionError: () => console.warn('[biometrics] Shadow scheduling or execution failed'),
  })
  shared.__biometricShadowService = { service, configurationHash }
  service.start()
  return service
}

export async function stopShadowService() {
  const current = shared.__biometricShadowService
  if (!current) return
  await current.service.stop()
  if (shared.__biometricShadowService === current) delete shared.__biometricShadowService
}

/** Durable stop must be recorded before invoking this local cleanup helper. */
export async function cancelShadowServiceAttempt(runId: string) {
  return await shared.__biometricShadowService?.service.cancel(runId) ?? false
}
