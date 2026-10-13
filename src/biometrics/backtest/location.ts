import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReferenceInputError } from '../references/time'

/** Server-owned fixed package locations; no caller-supplied executable paths.
 * These bundles are emitted by scripts/build/biometrics-worker.mjs AFTER Next
 * tracing. Tracing their runtime probes would recursively include the build tree. */
export function packagedWorkerPath() {
  for (const relative of ['biometrics-worker/worker.cjs', '.next/standalone/biometrics-worker/worker.cjs']) {
    const path = resolve(/* turbopackIgnore: true */ relative)
    if (existsSync(/* turbopackIgnore: true */ path)) return path
  }
  throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Build the packaged biometrics worker before submitting a replay')
}

export function packagedCoordinatorPath() {
  for (const relative of ['biometrics-worker/coordinator.cjs', '.next/standalone/biometrics-worker/coordinator.cjs']) {
    const path = resolve(/* turbopackIgnore: true */ relative)
    if (existsSync(/* turbopackIgnore: true */ path)) return path
  }
  throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Build the packaged biometrics coordinator before accessing retained evaluation data')
}

export function packagedShadowHostPath() {
  for (const relative of ['biometrics-worker/shadow-host.cjs', '.next/standalone/biometrics-worker/shadow-host.cjs']) {
    const path = resolve(/* turbopackIgnore: true */ relative)
    if (existsSync(/* turbopackIgnore: true */ path)) return path
  }
  throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Build the packaged shadow host before scheduling prospective runs')
}
