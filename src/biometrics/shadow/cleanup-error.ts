/** Structural code survives the separately bundled installed host boundary. */
export class ShadowCleanupError extends Error {
  readonly code = 'SHADOW_CLEANUP_UNCONFIRMED'
  constructor(cause?: unknown) {
    super('shadow_worker_cleanup_unconfirmed', { cause })
    this.name = 'ShadowCleanupError'
  }
}
export function isShadowCleanupError(error: unknown): error is Error & { code: 'SHADOW_CLEANUP_UNCONFIRMED' } {
  return error instanceof Error && 'code' in error && error.code === 'SHADOW_CLEANUP_UNCONFIRMED'
}
