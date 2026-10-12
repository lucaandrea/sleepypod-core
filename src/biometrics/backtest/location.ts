import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReferenceInputError } from '../references/time'

/** Server-owned fixed package locations; no caller-supplied executable paths. */
export function packagedWorkerPath() {
  for (const relative of ['biometrics-worker/worker.cjs', '.next/standalone/biometrics-worker/worker.cjs']) {
    const path = resolve(relative)
    if (existsSync(path)) return path
  }
  throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Build the packaged biometrics worker before submitting a replay')
}

export function packagedCoordinatorPath() {
  for (const relative of ['biometrics-worker/coordinator.cjs', '.next/standalone/biometrics-worker/coordinator.cjs']) {
    const path = resolve(relative)
    if (existsSync(path)) return path
  }
  throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Build the packaged biometrics coordinator before accessing retained evaluation data')
}
