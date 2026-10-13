/** Runtime-neutral entrypoint. Keep literal runtime checks around dynamic
 * imports so Next can exclude hardware/database code from its Edge bundle. */
export function shouldRunInstrumentation(env: Record<string, string | undefined> = process.env): boolean {
  return !env.NEXT_RUNTIME || env.NEXT_RUNTIME === 'nodejs'
}

export async function register(): Promise<void> {
  if (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } = await import('./src/server/instrumentation-node')
    await registerNodeInstrumentation()
  }
}

/** Compatibility entrypoint for callers that initialize the scheduler directly. */
export async function initializeScheduler(): Promise<void> {
  if (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs') {
    const node = await import('./src/server/instrumentation-node')
    await node.initializeScheduler()
  }
}
