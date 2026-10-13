import { admissionPolicySchema, collectAdmissionSample, evaluateAdmission } from '../backtest/admission'
import type { AdmissionSample } from '../backtest/admission'

/** One collection in flight, with a deadline derived from the installed policy.
 * Timeout is terminal: uncancellable filesystem I/O must not accumulate behind
 * retries. The attempt observes null on its next synchronous admission check. */
export async function startShadowHealthMonitor(collect: () => Promise<AdmissionSample | null>, rawPolicy: unknown, signal?: AbortSignal) {
  const policy = admissionPolicySchema.parse(rawPolicy)
  const cadenceMs = Math.min(1000, Math.floor(policy.maximumSampleAgeMs / 2))
  if (cadenceMs < 1) throw new Error('Shadow health freshness policy is too short')
  let closed = false, sample: AdmissionSample | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined
  let rejectPending: ((error: Error) => void) | undefined
  const close = () => {
    closed = true
    sample = null
    clearTimeout(refreshTimer)
    clearTimeout(deadline)
    signal?.removeEventListener('abort', close)
    rejectPending?.(new Error('Shadow health monitor closed'))
  }
  const refresh = async () => {
    if (closed) throw new Error('Shadow health monitor closed')
    try {
      const collected = await Promise.race([Promise.resolve().then(() => {
        if (closed) throw new Error('Shadow health monitor closed')
        return collect()
      }), new Promise<never>((_resolve, reject) => {
        rejectPending = reject
        deadline = setTimeout(() => reject(new Error('Shadow health collection deadline exceeded')), cadenceMs)
      })])
      if (closed) throw new Error('Shadow health monitor closed')
      sample = collected ? structuredClone(collected) : null
    }
    catch (error) {
      close()
      throw error
    }
    finally {
      clearTimeout(deadline)
      rejectPending = undefined
    }
  }
  const schedule = () => {
    if (closed) return
    refreshTimer = setTimeout(() => {
      void refresh().then(schedule).catch(() => {})
    }, cadenceMs)
  }
  signal?.addEventListener('abort', close, { once: true })
  if (signal?.aborted) close()
  await refresh()
  schedule()
  return {
    read: () => !closed && evaluateAdmission(sample, policy).admitted ? structuredClone(sample) : null,
    close,
  }
}

/** Production collector uses host filesystem health and the actual live piezo
 * receive clock. Paths and qualification policy are supplied by the host only. */
export async function openShadowHealthMonitor(databaseDirectory: string, policy: unknown, piezoReceivedAt: () => number | undefined, signal?: AbortSignal) {
  return startShadowHealthMonitor(() => collectAdmissionSample(databaseDirectory, piezoReceivedAt), policy, signal)
}
