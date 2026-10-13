import { admissionReceiptSchema, type AdmissionReceipt } from './job-operations'
import { replayBudgetSchema } from './execution-budget'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { performCoordinatorTask } from './coordinator-tasks'

// One operation per process. The supervisor owns this process group, including
// the evaluator grandchild; losing the supervisor IPC channel cancels all work.
const [databasePath, workerPath, rawLocationJson, replayBudgetJson] = process.argv.slice(2)
let started = false, completed = false, sequence = 0
const controller = new AbortController()
let lastAdmission: AdmissionReceipt | null = null
const pending = new Map<number, (receipt: AdmissionReceipt) => void>()
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
  const data = message as { type?: string, sequence?: number, allowed?: boolean, sample?: unknown, memory?: unknown, task?: unknown }
  if (data?.type === 'cancel') {
    controller.abort()
    return
  }
  if (data?.type === 'admission' && typeof data.sequence === 'number') {
    const receipt = admissionReceiptSchema.safeParse({ allowed: data.allowed, sample: data.sample ?? null, ...(data.memory === undefined ? {} : { memory: data.memory }) })
    pending.get(data.sequence)?.(receipt.success ? receipt.data : { allowed: false, sample: null })
    return
  }
  if (data?.type !== 'run' || started) return
  started = true
  let sqlite: Database.Database | undefined
  try {
    const replayBudget = replayBudgetJson && replayBudgetJson !== 'null' ? replayBudgetSchema.parse(JSON.parse(replayBudgetJson)) : undefined
    sqlite = new Database(databasePath, { fileMustExist: true, timeout: 1000 })
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    const result = await performCoordinatorTask(db, data.task, { workerPath, replayBudget, rawLocation: rawLocationJson ? JSON.parse(rawLocationJson) ?? undefined : undefined, signal: controller.signal, admissionReceipt: () => lastAdmission, admit: () => new Promise<boolean>((resolve) => {
      const id = ++sequence
      const finish = (receipt: AdmissionReceipt) => {
        clearTimeout(timer)
        pending.delete(id)
        lastAdmission = receipt
        resolve(receipt.allowed)
      }
      const timer = setTimeout(() => finish({ allowed: false, sample: null }), 2000)
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
