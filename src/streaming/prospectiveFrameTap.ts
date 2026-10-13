/** Read-only prospective fanout. No replay/backlog frames or hardware handles.
 * Kept on globalThis because server bundles may load multiple module instances. */
interface Listener { frame: (frame: Record<string, unknown>, observedAtMs: number) => void, failed: () => void }
const globalState = globalThis as typeof globalThis & { __sleepypodProspectiveFrames?: Set<Listener> }
const listeners = globalState.__sleepypodProspectiveFrames ??= new Set<Listener>()

export function subscribeProspectiveFrames(listener: Listener) {
  if (listeners.size >= 4) throw new Error('Prospective sensor subscriber limit exceeded')
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishProspectiveFrame(frame: Record<string, unknown>, backlog: boolean, observedAtMs: number) {
  if (backlog || (frame.type !== 'piezo-dual' && frame.type !== 'frzHealth')) return
  for (const listener of listeners) {
    try {
      listener.frame(frame, observedAtMs)
    }
    catch {
      listeners.delete(listener)
      try {
        listener.failed()
      }
      catch { /* A shadow consumer must never interrupt live ingestion. */ }
    }
  }
}

/** Source shutdown is a gap, not a successful end of observation. */
export function failProspectiveFrames() {
  const failed = [...listeners]
  listeners.clear()
  for (const listener of failed) {
    try {
      listener.failed()
    }
    catch { /* Preserve live source shutdown despite consumer failures. */ }
  }
}
