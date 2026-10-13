import { resolveShadowProfiles } from './profiles'
import { dirname } from 'node:path'
import { dataHash } from '../algorithms/canonical'
import { shadowPlanSchema, type ShadowStore } from './store'
import { installedShadowAdmitter, readInstalledShadowQualifications } from './admission'
import { openShadowActiveDatabase } from './active-database'
import { openShadowHealthMonitor } from './health-monitor'
import { shadowRuntimeBindingReader } from './runtime-binding'
import { plannedShadowSourceFactory } from './planned-sources'
import { runShadowAttempt, type ShadowAttemptHost } from './attempt'

export interface ShadowHostInstallation {
  workerPath: string
  pythonPath: string
  modulesPath: string
  configurationDatabase: string
  biometricsDatabase: string
  presenceFile: string
  configs: { left: unknown, right: unknown }
  expectedBindings: Record<'left' | 'right', { generation: number, resolvedHash: string }>
  /** Trusted installed-build/hardware collector; must detect changes, never RPC data. */
  identity: () => unknown
  piezoReceivedAt: () => number | undefined
}

/** Own admission connections and health sampling for exactly one saved plan.
 * Qualification lookup precedes I/O sampling; no source subscription or worker
 * launch occurs until the attempt controller has claimed its fenced lease. */
export async function openPlannedShadowHost(rawPlan: unknown, installation: ShadowHostInstallation, signal?: AbortSignal) {
  const plan = shadowPlanSchema.parse(rawPlan), planHash = dataHash(plan)
  if (!plan.execution || !plan.joining) throw new Error('Shadow host requires a saved execution policy')
  const { identity, piezoReceivedAt, ...rawLocations } = installation
  const locations = structuredClone(rawLocations)
  const controller = new AbortController()
  let closed = false
  let config: ReturnType<typeof openShadowActiveDatabase> | undefined, bio: ReturnType<typeof openShadowActiveDatabase> | undefined
  let health: Awaited<ReturnType<typeof openShadowHealthMonitor>> | undefined
  const close = () => {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', close)
    controller.abort()
    try {
      health?.close()
    }
    finally {
      try {
        config?.close()
      }
      finally { bio?.close() }
    }
  }
  signal?.addEventListener('abort', close, { once: true })
  if (signal?.aborted) close()
  try {
    if (closed) throw new Error('Shadow host cancelled before opening')
    const entries = readInstalledShadowQualifications(locations.workerPath).entries.filter(entry => dataHash(entry) === plan.qualificationHash)
    if (entries.length !== 1) throw new Error('Shadow qualification missing or ambiguous')
    const databaseOptions = { busyTimeoutMs: plan.execution.sources.databaseBusyTimeoutMs }
    config = openShadowActiveDatabase(locations.configurationDatabase, databaseOptions)
    bio = openShadowActiveDatabase(locations.biometricsDatabase, databaseOptions)
    const configuration = config, biometrics = bio
    const binding = shadowRuntimeBindingReader(configuration.db, biometrics.db, { side: plan.side, expected: locations.expectedBindings,
      assertCurrent: () => {
        configuration.assertCurrent()
        biometrics.assertCurrent()
      } })
    health = await openShadowHealthMonitor(dirname(locations.biometricsDatabase), entries[0].healthPolicy, piezoReceivedAt, controller.signal)
    if (closed) {
      health.close()
      throw new Error('Shadow host cancelled while opening')
    }
    const admission = installedShadowAdmitter({ workerPath: locations.workerPath,
      expectedBinding: { side: plan.side, ...locations.expectedBindings[plan.side] }, identity, binding, health: health.read })
    const host: ShadowAttemptHost = {
      location: { pythonPath: locations.pythonPath, modulesPath: locations.modulesPath }, configs: locations.configs,
      admit: (candidate) => {
        if (closed || dataHash(candidate) !== planHash) throw new Error('Shadow host closed or saved plan changed')
        admission(candidate)
      },
      openSources: plannedShadowSourceFactory(plan, locations),
    }
    host.admit(plan)
    return { host, signal: controller.signal, close }
  }
  catch (error) {
    close()
    throw error
  }
}

/** Own cleanup even when claim fails, the worker fails, or a caller cancels. */
export async function runPlannedShadowAttempt(store: ShadowStore, runId: string, installation: ShadowHostInstallation, signal?: AbortSignal) {
  const owned = await openPlannedShadowHost(store.get(runId).plan, installation, signal)
  try {
    return await runShadowAttempt(store, runId, owned.host, owned.signal)
  }
  finally { owned.close() }
}

/** Public service integration supplies a saved revision ID, never resolved
 * numerical configs or asserted active generations. Admission rechecks the
 * captured generations after these snapshot handles have been closed. */
export async function runProfiledShadowAttempt(store: ShadowStore, runId: string,
  installation: Omit<ShadowHostInstallation, 'configs' | 'expectedBindings'>, revisionId: string | null, signal?: AbortSignal) {
  const owned = await openProfiledShadowHost(store.get(runId).plan, installation, revisionId, signal)
  try {
    return await runShadowAttempt(store, runId, owned.host, owned.signal)
  }
  finally { owned.close() }
}

/** Admission-only preparation for a proposed plan. Does not launch a worker,
 * claim a lease or open sensor sources. Caller owns the returned resources. */
export async function openProfiledShadowHost(rawPlan: unknown,
  installation: Omit<ShadowHostInstallation, 'configs' | 'expectedBindings'>, revisionId: string | null, signal?: AbortSignal) {
  const plan = shadowPlanSchema.parse(rawPlan)
  if (!plan.execution) throw new Error('Shadow profile resolution requires execution policy')
  if (signal?.aborted) throw new Error('Shadow attempt cancelled before profile resolution')
  const options = { busyTimeoutMs: plan.execution.sources.databaseBusyTimeoutMs }
  const configuration = openShadowActiveDatabase(installation.configurationDatabase, options)
  let biometrics: ReturnType<typeof openShadowActiveDatabase> | undefined
  let resolved: ReturnType<typeof resolveShadowProfiles>
  try {
    biometrics = openShadowActiveDatabase(installation.biometricsDatabase, options)
    const bio = biometrics
    resolved = resolveShadowProfiles(configuration.db, bio.db, plan, revisionId, () => {
      configuration.assertCurrent()
      bio.assertCurrent()
    })
  }
  finally {
    try {
      configuration.close()
    }
    finally { biometrics?.close() }
  }
  return openPlannedShadowHost(plan, { ...installation, configs: resolved.configs, expectedBindings: resolved.expectedBindings }, signal)
}
