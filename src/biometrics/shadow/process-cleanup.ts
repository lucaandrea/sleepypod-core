import { setTimeout as delay } from 'node:timers/promises'

/** Confirm both the owned child's close event and disappearance of its detached
 * process group. Signal 0 observes existence; only ESRCH proves absence.
 * Zombies and permission failures remain unconfirmed. Never signal PID/group 0.
 * This cannot account for descendants that escape into a different group. */
export async function confirmShadowProcessCleanup(pid: number | undefined, isClosed: () => boolean, timeoutMs = 5000) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) return false
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return false
  const deadline = performance.now() + timeoutMs
  while (true) {
    let absent = pid === undefined
    if (pid !== undefined) {
      try {
        process.kill(-pid, 0)
      }
      catch (error) {
        // Some kernels briefly return EPERM while killed children are reaped.
        // Retry unknown observations within the deadline; never call them absent.
        absent = (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }
    if (absent && isClosed()) return true
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    await delay(Math.min(25, remaining))
  }
}
