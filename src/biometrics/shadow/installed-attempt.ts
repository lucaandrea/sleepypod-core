import { withBiometricBackgroundSlot } from '../background-admission'
import { z } from 'zod'
import { dataHash } from '../algorithms/canonical'
import { getSensorFrameTimes } from '@/src/streaming/piezoStream'
import type { ShadowStore } from './store'
import { inspectInstalledShadowHost, loadInstalledShadowHost } from './installed-host'
import { installedShadowIdentity } from './device-identity'
import { openShadowStateDatabase } from './active-database'
import type { ShadowHostInstallation } from './host'

type Installation = Pick<ShadowHostInstallation, 'workerPath' | 'pythonPath' | 'modulesPath' | 'configurationDatabase' | 'biometricsDatabase' | 'presenceFile'>

/** Application-side execution boundary. Paths/storage policy are trusted service
 * configuration. User operations identify only an existing run and revision.
 * Executes the inspected package, never the source-copy attempt controller. */
async function runAdmittedShadowAttempt(runId: string, revisionId: string | null, installation: Installation,
  storagePolicy: unknown, busyTimeoutMs: number, signal?: AbortSignal) {
  z.string().uuid().parse(runId)
  z.string().uuid().nullable().parse(revisionId)
  z.number().int().min(1).max(1000).parse(busyTimeoutMs)
  const paths = structuredClone(installation), policy = structuredClone(storagePolicy)
  if (signal?.aborted) throw new Error('Installed shadow attempt cancelled')
  const inspected = await inspectInstalledShadowHost(paths.workerPath, paths, signal)
  if (signal?.aborted) throw new Error('Installed shadow attempt cancelled')
  inspected.assertCurrent()
  const database = openShadowStateDatabase(paths.biometricsDatabase, { busyTimeoutMs })
  try {
    const store = new inspected.api.ShadowStore(database.db, policy)
    const plan = store.get(runId).plan
    if (!plan.expectedBindings) throw new Error('Shadow active generations missing from saved plan')
    if (plan.candidateRevisionId === undefined || plan.candidateRevisionId !== revisionId) throw new Error('Shadow candidate revision differs from saved plan')
    if (!plan.execution || busyTimeoutMs > plan.execution.sources.databaseBusyTimeoutMs) throw new Error('Shadow store timeout exceeds saved execution policy')
    const entries = inspected.api.readInstalledShadowQualifications(paths.workerPath).entries.filter(entry => dataHash(entry) === plan.qualificationHash)
    if (entries.length !== 1) throw new Error('Shadow qualification missing or ambiguous')
    const observedIdentity = installedShadowIdentity(inspected, entries[0])
    const identity = () => {
      database.assertCurrent()
      return observedIdentity()
    }
    identity()
    return await inspected.api.runProfiledShadowAttempt(store, runId, { ...paths, identity,
      piezoReceivedAt: () => getSensorFrameTimes()['piezo-dual'] }, revisionId, signal)
  }
  finally { database.close() }
}

/** Reserve before build probes, database ownership, source subscription or claim.
 * Busy pending runs remain pending for the service's next scheduling pass. */
export function runInstalledShadowAttempt(...args: Parameters<typeof runAdmittedShadowAttempt>) {
  return withBiometricBackgroundSlot('work', () => runAdmittedShadowAttempt(...args))
}

/** Queue inspection runs the verified package with an owned state connection. */
export function pendingInstalledShadowRun(installation: Pick<Installation, 'workerPath' | 'biometricsDatabase'>,
  storagePolicy: unknown, busyTimeoutMs: number, options: Parameters<ShadowStore['pending']>[0]) {
  z.number().int().min(1).max(1000).parse(busyTimeoutMs)
  const loaded = loadInstalledShadowHost(installation.workerPath)
  loaded.assertCurrent()
  const database = openShadowStateDatabase(installation.biometricsDatabase, { busyTimeoutMs })
  try {
    database.assertCurrent()
    const result = new loaded.api.ShadowStore(database.db, storagePolicy).pending(options)
    database.assertCurrent()
    loaded.assertCurrent()
    return result
  }
  finally { database.close() }
}

/** Recovery needs the installed store implementation but never starts a Python
 * probe/worker, subscribes to sensors or requires an admission qualification. */
export function reconcileInstalledShadowRuns(installation: Pick<Installation, 'workerPath' | 'biometricsDatabase'>,
  storagePolicy: unknown, busyTimeoutMs: number, options: Parameters<ShadowStore['reconcileExpired']>[0]) {
  z.number().int().min(1).max(1000).parse(busyTimeoutMs)
  const loaded = loadInstalledShadowHost(installation.workerPath)
  loaded.assertCurrent()
  const database = openShadowStateDatabase(installation.biometricsDatabase, { busyTimeoutMs })
  try {
    database.assertCurrent()
    const store = new loaded.api.ShadowStore(database.db, storagePolicy)
    const result = store.reconcileExpired(options)
    database.assertCurrent()
    loaded.assertCurrent()
    return result
  }
  finally { database.close() }
}
