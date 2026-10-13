import type { HealthAdmission } from './job-operations'
import { dirname } from 'node:path'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@/src/db/biometrics-schema'
import { admissionPolicySchema, collectAdmissionSample, evaluateAdmission } from './admission'

export const replayAdmissionSchema = z.object({
  configured: z.boolean(), qualificationId: z.string().nullable(), admitted: z.boolean(),
  reasons: z.array(z.enum(['unqualified', 'health_unavailable', 'stale_sample', 'clock_skew',
    'memory_pressure', 'disk_pressure', 'cpu_pressure', 'event_loop_delay', 'piezo_stale', 'temperature'])),
}).strict()

/** Server-owned policy only. Missing or malformed configuration never enables
 * background I/O. The qualification ID is operator-supplied evidence attribution,
 * not an assertion that supplying JSON has qualified the hardware.
 */
async function measuredReplayAdmission(db: BetterSQLite3Database<typeof schema>): Promise<z.infer<typeof replayAdmissionSchema> & { receipt?: Awaited<ReturnType<HealthAdmission>> }> {
  const policy = configuredReplayPolicy()
  if (!policy) return { configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] }
  try {
    const path = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
    if (!path) throw new Error('Missing persistent database')
    const { getSensorFrameTimes } = await import('@/src/streaming/piezoStream')
    const sample = await collectAdmissionSample(dirname(path), () => getSensorFrameTimes()['piezo-dual'])
    const checkedAtMs = Date.now()
    const decision = evaluateAdmission(sample, policy, checkedAtMs)
    return { configured: true, qualificationId: policy.qualificationId, ...decision,
      receipt: { allowed: decision.admitted, sample: decision.admitted && sample
        ? { qualificationId: policy.qualificationId, checkedAtMs, ingestionAgeMs: checkedAtMs - sample.piezoReceivedAtMs }
        : null } }
  }
  catch { return { configured: true, qualificationId: policy.qualificationId, admitted: false, reasons: ['health_unavailable'] } }
}

export async function replayAdmission(db: BetterSQLite3Database<typeof schema>) {
  const { configured, qualificationId, admitted, reasons } = await measuredReplayAdmission(db)
  return replayAdmissionSchema.parse({ configured, qualificationId, admitted, reasons })
}

export function replayHealthAdmission(db: BetterSQLite3Database<typeof schema>): HealthAdmission {
  return async () => {
    const measured = await measuredReplayAdmission(db)
    return measured.receipt ?? { allowed: false, sample: null }
  }
}

export function replayAdmitter(db: BetterSQLite3Database<typeof schema>) {
  return async () => (await replayAdmission(db)).admitted
}

/** Reading configuration has no database, streaming or health side effects. */
export function configuredReplayPolicy() {
  try {
    return admissionPolicySchema.parse(JSON.parse(process.env.SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY ?? 'null'))
  }
  catch { return null }
}
