import { coordinatorTaskLanes as taskLanes, type CoordinatorLane as Lane } from './coordinator-lanes'
import { ReferenceInputError } from '../references/time'
import { runCoordinatorTask, type CoordinatorOptions } from './coordinator'
import type { CoordinatorTask, CoordinatorResults } from './coordinator-tasks'

interface Control { signal?: AbortSignal, admit?: () => Promise<boolean> }
interface Entry { lane: Lane, start: () => Promise<void>, reject: (error: Error) => void }

/** One serialized work slot plus one read slot, so replay cannot starve report
 * access. No writes or scans use the read slot. Eight requests total and seven
 * per lane reserve capacity for the other lane; pending waits remain bounded.
 * Both processes count toward the deployment's admission/resource qualification.
 */
export class CoordinatorQueue {
  private pending: Entry[] = []
  private active = new Map<Lane, Promise<void>>()
  private stopped = false
  private abort = new AbortController()
  constructor(private readonly options: CoordinatorOptions, private readonly execute = runCoordinatorTask) {}

  request<T extends CoordinatorTask>(task: T, control: Control = {}): Promise<CoordinatorResults[T['type']]> {
    if (this.stopped) return Promise.reject(new Error('Coordinator stopped'))
    if (control.signal?.aborted) return Promise.reject(new Error('Coordinator cancelled'))
    const lane = taskLanes[task.type] ?? 'work'
    if (this.pending.length + this.active.size >= 8
      || this.pending.filter(entry => entry.lane === lane).length + (this.active.has(lane) ? 1 : 0) >= 7) return Promise.reject(new ReferenceInputError('RESOURCE_LIMIT', 'Biometrics coordinator queue is full'))
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
        lane,
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
    if (this.stopped) return
    for (const lane of ['read', 'work'] as const) {
      if (this.active.has(lane)) continue
      const index = this.pending.findIndex(entry => entry.lane === lane)
      if (index === -1) continue
      const [next] = this.pending.splice(index, 1)
      this.active.set(lane, next.start().finally(() => {
        this.active.delete(lane)
        this.pump()
      }))
    }
  }

  async stop() {
    this.stopped = true
    this.abort.abort()
    for (const entry of [...this.pending]) entry.reject(new Error('Coordinator stopped'))
    await Promise.all(this.active.values())
  }
}
