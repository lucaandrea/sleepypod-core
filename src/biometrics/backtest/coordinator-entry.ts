import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { performCoordinatorTask } from './coordinator-tasks'

// One operation per process. The supervisor owns this process group, including
// the evaluator grandchild; losing the supervisor IPC channel cancels all work.
const [databasePath, workerPath, rawLocationJson] = process.argv.slice(2)
let started = false, completed = false, sequence = 0
const controller = new AbortController()
const pending = new Map<number, (allowed: boolean) => void>()
process.on('disconnect', () => {
  if (completed) return
  controller.abort()
  // The launcher creates this process group. If it dies, clean up our child too.
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL')
    }
    catch { /* Fall through if the supervisor already removed the group. */ }
  }
  process.exit(1)
})
process.on('message', async (message: unknown) => {
  const data = message as { type?: string, sequence?: number, allowed?: boolean, task?: unknown }
  if (data?.type === 'cancel') {
    controller.abort()
    return
  }
  if (data?.type === 'admission' && typeof data.sequence === 'number') {
    pending.get(data.sequence)?.(data.allowed === true)
    return
  }
  if (data?.type !== 'run' || started) return
  started = true
  let sqlite: Database.Database | undefined
  try {
    sqlite = new Database(databasePath, { fileMustExist: true, timeout: 1000 })
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    const result = await performCoordinatorTask(db, data.task, { workerPath, rawLocation: rawLocationJson ? JSON.parse(rawLocationJson) ?? undefined : undefined, signal: controller.signal, admit: () => new Promise<boolean>((resolve) => {
      const id = ++sequence
      const finish = (allowed: boolean) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(allowed)
      }
      const timer = setTimeout(() => finish(false), 2000)
      pending.set(id, finish)
      process.send?.({ type: 'admission', sequence: id })
    }) })
    if (Buffer.byteLength(JSON.stringify(result)) > 17 * 1024 * 1024) throw new Error('Coordinator response exceeds byte limit')
    process.send?.({ type: 'result', result }, () => {
      completed = true
      process.disconnect?.()
    })
  }
  catch (error) {
    // Known input errors preserve their codes; generic errors never log exports.
    process.send?.({ type: 'error', code: error instanceof ReferenceInputError ? error.code : 'COORDINATOR_FAILED',
      message: error instanceof ReferenceInputError ? error.message.slice(0, 1000) : 'Biometrics coordinator failed' }, () => {
      completed = true
      process.disconnect?.()
    })
  }
  finally {
    sqlite?.close()
  }
})
