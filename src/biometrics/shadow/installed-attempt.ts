import { z } from 'zod'
import { dataHash } from '../algorithms/canonical'
import { getSensorFrameTimes } from '@/src/streaming/piezoStream'
import { inspectInstalledShadowHost } from './installed-host'
import { installedShadowIdentity } from './device-identity'
import { openShadowStateDatabase } from './active-database'
import type { ShadowHostInstallation } from './host'

type Installation = Pick<ShadowHostInstallation, 'workerPath' | 'pythonPath' | 'modulesPath' | 'configurationDatabase' | 'biometricsDatabase' | 'presenceFile'>

/** Application-side execution boundary. Paths/storage policy are trusted service
 * configuration. User operations identify only an existing run and revision.
 * Executes the inspected package, never the source-copy attempt controller. */
export async function runInstalledShadowAttempt(runId: string, revisionId: string | null, installation: Installation,
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
