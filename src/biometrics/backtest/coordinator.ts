import { withBiometricBackgroundSlot } from '../background-admission'
import { coordinatorTaskLanes } from './coordinator-lanes'
import { confirmShadowProcessCleanup } from '../shadow/process-cleanup'
import { monitorProcessGroupMemory } from './process-group-memory'
import { admissionReceiptSchema, type HealthAdmission } from './job-operations'
import { fork } from 'node:child_process'
import { setPriority } from 'node:os'
import { dirname, resolve } from 'node:path'
import { ReferenceInputError } from '../references/time'
import { coordinatorTaskSchema, type CoordinatorTask, type CoordinatorResults } from './coordinator-tasks'

import { replayBudgetSchema, type ReplayBudget } from './execution-budget'
import type { RawInspectionLocation } from './raw-inspection-child'

export interface CoordinatorOptions {
  databasePath: string
  coordinatorPath: string
  workerPath: string
  rawLocation?: RawInspectionLocation
  modulePath?: string
  timeoutMs?: number
  replayBudget?: ReplayBudget
}

/** Own an OS process group so crashes/timeouts cannot orphan the evaluator. */
export function runCoordinatorTask<T extends CoordinatorTask>(options: CoordinatorOptions, task: T, control: {
  signal?: AbortSignal
  admit?: () => Promise<boolean>
  healthAdmission?: HealthAdmission
} = {}): Promise<CoordinatorResults[T['type']]> {
  const parsed = coordinatorTaskSchema.parse(task)
  if (Buffer.byteLength(JSON.stringify(parsed)) > 65536) return Promise.reject(new ReferenceInputError('RESOURCE_LIMIT', 'Coordinator input exceeds 64 KiB'))
  const replayBudget = options.replayBudget === undefined ? undefined : replayBudgetSchema.parse(options.replayBudget)
  const timeoutMs = options.timeoutMs ?? (parsed.type === 'execute' ? replayBudget?.jobWallMs : undefined) ?? 150000
  const maximumTimeout = parsed.type === 'execute' && replayBudget ? replayBudget.jobWallMs : 180000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > maximumTimeout) throw new Error('Invalid coordinator timeout')
  if (control.signal?.aborted) return Promise.reject(new Error('Coordinator cancelled'))
  return withBiometricBackgroundSlot(coordinatorTaskLanes[parsed.type], () => new Promise((resolveResult, reject) => {
    const child = fork(resolve(options.coordinatorPath), [resolve(options.databasePath), resolve(options.workerPath), JSON.stringify(options.rawLocation ?? null), JSON.stringify(parsed.type === 'execute' ? replayBudget ?? null : null)], {
      cwd: dirname(resolve(options.databasePath)), detached: process.platform !== 'win32', serialization: 'advanced',
      execArgv: ['--max-old-space-size=384'], silent: true,
      env: { NODE_ENV: 'production', LANG: 'C.UTF-8', TZ: 'UTC', NODE_PATH: options.modulePath ?? resolve('node_modules') },
    })
    const memory = parsed.type === 'execute' && child.pid ? monitorProcessGroupMemory(child.pid) : null
    let settled = false, received = false, result: CoordinatorResults[T['type']], failure: Error | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    let cancellationGrace: ReturnType<typeof setTimeout> | undefined
    let diagnostics = 0, admissionActive = false
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      }
      catch { /* Already exited. */ }
    }
    const stop = (error: Error) => {
      failure ??= error
      killGroup('SIGTERM')
      grace ??= setTimeout(() => killGroup('SIGKILL'), 500)
    }
    const timer = setTimeout(() => stop(new Error('Coordinator time budget exceeded')), timeoutMs)
    const cancel = () => {
      failure ??= new Error('Coordinator cancelled')
      if (child.connected) child.send({ type: 'cancel' }, () => {})
      cancellationGrace ??= setTimeout(() => stop(new Error('Coordinator cancellation grace expired')), 2000)
    }
    control.signal?.addEventListener('abort', cancel, { once: true })
    if (control.signal?.aborted) cancel()
    const count = (chunk: Buffer) => {
      diagnostics += chunk.length
      if (diagnostics > 16384) stop(new Error('Coordinator diagnostics exceeded byte limit'))
    }
    child.stdout?.on('data', count)
    child.stderr?.on('data', count)
    child.on('error', stop)
    child.on('message', (message: unknown) => {
      const data = message as { type?: string, sequence?: number, result?: CoordinatorResults[T['type']], code?: string, message?: string }
      if (data?.type === 'admission' && (parsed.type === 'execute' || parsed.type === 'inspectRawSource' || parsed.type === 'createWaveformDataset' || parsed.type === 'collectArtifacts') && !received && !admissionActive && Number.isSafeInteger(data.sequence)) {
        admissionActive = true
        Promise.resolve().then(async () => control.healthAdmission
          ? admissionReceiptSchema.parse(await control.healthAdmission())
          : { allowed: await control.admit?.() ?? false, sample: null }).catch(() => ({ allowed: false, sample: null })).then(async (receipt) => {
          await memory?.sample()
          if (child.connected && !failure) child.send({ type: 'admission', sequence: data.sequence, ...receipt, ...(memory ? { memory: memory.snapshot() } : {}) }, () => {})
        }).finally(() => { admissionActive = false })
      }
      else if (data?.type === 'result' && !received) {
        received = true
        result = data.result as CoordinatorResults[T['type']]
      }
      else if (data?.type === 'error' && typeof data.code === 'string' && typeof data.message === 'string') {
        stop(new ReferenceInputError(data.code, data.message))
      }
      else stop(new Error('Invalid coordinator response'))
    })
    child.on('close', async (code) => {
      if (settled) return
      settled = true
      void memory?.stop()
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      if (cancellationGrace) clearTimeout(cancellationGrace)
      control.signal?.removeEventListener('abort', cancel)
      // Also kill descendants if the coordinator crashed before reporting them.
      killGroup('SIGKILL')
      if (process.platform !== 'win32' && !await confirmShadowProcessCleanup(child.pid, () => true)) {
        reject(Object.assign(new Error('Biometrics coordinator process-group cleanup unconfirmed', { cause: failure }), { code: 'BIOMETRIC_COORDINATOR_CLEANUP_UNCONFIRMED' }))
        return
      }
      if (failure) reject(failure)
      else if (!received || code !== 0) reject(new Error('Coordinator exited without a complete result'))
      else resolveResult(result)
    })
    try {
      if (child.pid) setPriority(child.pid, 19)
      child.send({ type: 'run', task: parsed }, (error) => {
        if (error) stop(error)
      })
    }
    catch { stop(new Error('Could not start coordinator')) }
  }))
}
