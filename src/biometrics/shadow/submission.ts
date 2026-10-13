import { z } from 'zod'
import { dataHash } from '../algorithms/canonical'
import { submitShadowSchema } from './submission-contracts'
import { loadInstalledShadowHost, inspectInstalledShadowHost } from './installed-host'
import { openShadowStateDatabase } from './active-database'
import { installedShadowIdentity } from './device-identity'
import { getSensorFrameTimes } from '@/src/streaming/piezoStream'
import type { runInstalledShadowAttempt } from './installed-attempt'

export { submitShadowSchema } from './submission-contracts'

/** Assertions in a proposed plan are checked against installed qualification and
 * fresh observations. A request cannot supply paths, resolved configs or health.
 * Exact retries return durable evidence before any new Python/health work. */
export async function submitInstalledShadow(raw: z.input<typeof submitShadowSchema>,
  installation: Parameters<typeof runInstalledShadowAttempt>[2], storagePolicy: unknown, busyTimeoutMs: number, signal?: AbortSignal) {
  const input = submitShadowSchema.parse(raw), paths = structuredClone(installation), policy = structuredClone(storagePolicy)
  z.number().int().min(1).max(1000).parse(busyTimeoutMs)
  if (busyTimeoutMs > input.plan.execution.sources.databaseBusyTimeoutMs) throw new Error('Shadow store timeout exceeds saved execution policy')
  if (signal?.aborted) throw new Error('Shadow submission cancelled')
  const loaded = loadInstalledShadowHost(paths.workerPath)
  loaded.assertCurrent()
  const database = openShadowStateDatabase(paths.biometricsDatabase, { busyTimeoutMs })
  let owned: Awaited<ReturnType<typeof loaded.api.openProfiledShadowHost>> | undefined
  try {
    database.assertCurrent()
    const store = new loaded.api.ShadowStore(database.db, policy)
    const previous = store.findCreated(input.plan, input.idempotencyKey)
    if (previous) return previous
    const inspected = await inspectInstalledShadowHost(paths.workerPath, paths, signal)
    if (signal?.aborted) throw new Error('Shadow submission cancelled')
    inspected.assertCurrent()
    database.assertCurrent()
    const entries = inspected.api.readInstalledShadowQualifications(paths.workerPath).entries.filter(entry => dataHash(entry) === input.plan.qualificationHash)
    if (entries.length !== 1) throw new Error('Shadow qualification missing or ambiguous')
    const observed = installedShadowIdentity(inspected, entries[0])
    const identity = () => {
      database.assertCurrent()
      return observed()
    }
    owned = await inspected.api.openProfiledShadowHost(input.plan, { ...paths, identity,
      piezoReceivedAt: () => getSensorFrameTimes()['piezo-dual'] }, input.plan.candidateRevisionId, signal)
    if (signal?.aborted) throw new Error('Shadow submission cancelled')
    const host = owned.host
    return store.create(input.plan, input.idempotencyKey, (plan) => {
      inspected.assertCurrent()
      database.assertCurrent()
      host.admit(plan)
    })
  }
  finally {
    try {
      owned?.close()
    }
    finally { database.close() }
  }
}
