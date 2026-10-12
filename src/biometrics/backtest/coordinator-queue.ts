import { ReferenceInputError } from '../references/time'
import { runCoordinatorTask, type CoordinatorOptions } from './coordinator'
import type { CoordinatorTask, CoordinatorResults } from './coordinator-tasks'

interface Control { signal?: AbortSignal, admit?: () => Promise<boolean> }
interface Entry { start: () => Promise<void>, reject: (error: Error) => void }

/** All heavy operations share one process slot, including HTTP reads and replay.
 * Pending requests are bounded in count and wait time; shutdown drains no work.
 */
export class CoordinatorQueue {
  private pending: Entry[] = []
  private active: Promise<void> | null = null
  private stopped = false
  private abort = new AbortController()
  constructor(private readonly options: CoordinatorOptions, private readonly execute = runCoordinatorTask) {}

  request<T extends CoordinatorTask>(task: T, control: Control = {}): Promise<CoordinatorResults[T['type']]> {
    if (this.stopped) return Promise.reject(new Error('Coordinator stopped'))
    if (control.signal?.aborted) return Promise.reject(new Error('Coordinator cancelled'))
    if (this.pending.length + (this.active ? 1 : 0) >= 8) return Promise.reject(new ReferenceInputError('RESOURCE_LIMIT', 'Biometrics coordinator queue is full'))
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let started = false, finished = false
      const cleanup = () => {
        clearTimeout(timer)
        control.signal?.removeEventListener('abort', cancel)
        this.abort.signal.removeEventListener('abort', cancel)
      }
      const fail = (error: Error) => {
        if (finished) return
        finished = true
        cleanup()
        this.pending = this.pending.filter(row => row !== entry)
        reject(error)
      }
      const cancel = () => {
        controller.abort()
        if (!started) fail(new Error('Coordinator cancelled'))
      }
      const timer = setTimeout(() => fail(new ReferenceInputError('RESOURCE_LIMIT', 'Biometrics coordinator queue wait exceeded')), 30000)
      const entry: Entry = {
        reject: fail,
        start: async () => {
          started = true
          clearTimeout(timer)
          try {
            const result = await this.execute(this.options, task, { ...control, signal: controller.signal })
            if (!finished) resolve(result)
          }
          catch (error) { if (!finished) reject(error) }
          finally {
            finished = true
            cleanup()
          }
        },
      }
      control.signal?.addEventListener('abort', cancel, { once: true })
      this.abort.signal.addEventListener('abort', cancel, { once: true })
      this.pending.push(entry)
      this.pump()
    })
  }

  private pump() {
    if (this.stopped || this.active) return
    const next = this.pending.shift()
    if (!next) return
    this.active = next.start().finally(() => {
      this.active = null
      this.pump()
    })
  }

  async stop() {
    this.stopped = true
    this.abort.abort()
    for (const entry of [...this.pending]) entry.reject(new Error('Coordinator stopped'))
    await this.active
  }
}
