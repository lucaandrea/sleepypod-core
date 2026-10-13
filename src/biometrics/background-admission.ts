import { ReferenceInputError } from './references/time'

type Lane = 'read' | 'work'
interface Slot { token: symbol, quarantined: boolean }
const shared = globalThis as typeof globalThis & { __biometricBackgroundSlotsV1?: Partial<Record<Lane, Slot>> }

/** Application-process admission, shared across separately bundled modules.
 * Kernel numerical-worker locking remains necessary across processes/restarts. */
export function withBiometricBackgroundSlot<T>(lane: Lane, action: () => Promise<T>): Promise<T> {
  const slots = shared.__biometricBackgroundSlotsV1 ??= {}
  if (slots[lane]) return Promise.reject(new ReferenceInputError('RESOURCE_LIMIT', slots[lane].quarantined
    ? 'Biometrics background cleanup is unconfirmed; restart after verifying process cleanup'
    : 'Biometrics background capacity is busy; retry later'))
  const slot = { token: Symbol(lane), quarantined: false }
  slots[lane] = slot
  const release = (error?: unknown) => {
    if (slots[lane]?.token !== slot.token) return
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'SHADOW_CLEANUP_UNCONFIRMED' || code === 'BIOMETRIC_COORDINATOR_CLEANUP_UNCONFIRMED') slot.quarantined = true
    else slots[lane] = undefined
  }
  try {
    return action().then((result) => {
      release()
      return result
    }, (error: unknown) => {
      release(error)
      throw error
    })
  }
  catch (error) {
    release(error)
    throw error
  }
}
