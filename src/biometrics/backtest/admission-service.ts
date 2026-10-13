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
export async function replayAdmission(db: BetterSQLite3Database<typeof schema>): Promise<z.infer<typeof replayAdmissionSchema>> {
  let policy: z.infer<typeof admissionPolicySchema>
  try {
    policy = admissionPolicySchema.parse(JSON.parse(process.env.SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY ?? 'null'))
  }
  catch { return { configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] } }
  try {
    const path = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
    if (!path) throw new Error('Missing persistent database')
    const { getSensorFrameTimes } = await import('@/src/streaming/piezoStream')
    const sample = await collectAdmissionSample(dirname(path), () => getSensorFrameTimes()['piezo-dual'])
    return { configured: true, qualificationId: policy.qualificationId, ...evaluateAdmission(sample, policy) }
  }
  catch { return { configured: true, qualificationId: policy.qualificationId, admitted: false, reasons: ['health_unavailable'] } }
}

export function replayAdmitter(db: BetterSQLite3Database<typeof schema>) {
  return async () => (await replayAdmission(db)).admitted
}
