import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { configHash, dataHash } from '../../src/biometrics/algorithms/canonical'
import { timestampMsSchema } from '../../src/biometrics/references/contracts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().min(1).max(200)
const split = z.enum(['tuning', 'validation', 'holdout'])
export const packageStudySchema = z.object({ schema: z.literal('biometric-package-study-v1'), subjectId: key, side: z.enum(['left', 'right']),
  protocolHash: hash, nights: z.array(z.object({ id: key, startMs: timestampMsSchema, endMs: timestampMsSchema, inputHash: hash, referenceHash: hash, split }).strict()).min(1).max(60),
}).strict().superRefine((study, context) => {
  const order = { tuning: 0, validation: 1, holdout: 2 }
  if (new Set(study.nights.map(night => night.id)).size !== study.nights.length) context.addIssue({ code: 'custom', message: 'Duplicate night identity' })
  const sorted = [...study.nights].sort((a, b) => a.startMs - b.startMs)
  for (const [index, night] of sorted.entries()) {
    if (night.endMs <= night.startMs || night.endMs - night.startMs > 86400000) context.addIssue({ code: 'custom', message: 'Invalid whole-night interval' })
    if (index > 0 && (sorted[index - 1].endMs > night.startMs || order[sorted[index - 1].split] > order[night.split])) context.addIssue({ code: 'custom', message: 'Nights must be disjoint chronological splits' })
  }
})
const trialRequestSchema = z.object({ studyId: z.string().uuid(), split,
  variants: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']), packageHash: hash, configHash: hash, image: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).length(3),
}).strict().refine(request => new Set(request.variants.map(variant => variant.label)).size === 3, 'All three variants are required')
interface StudyRow { id: string, hash: string, payload: string }
interface TrialRow { id: string, request_hash: string, request: string, state: 'pending' | 'running' | 'succeeded' | 'failed', attempt_id: string | null, lease_until: number | null, report_hash: string | null }
export interface PackageTrialLease { trialId: string, attemptId: string }
const applicationId = 0x53504558

/** Dedicated off-pod metadata database, never the pod's configuration or vitals
 * database. Retain it across experiments: a fresh ledger cannot prove that a
 * night was never observed elsewhere. Publication is fenced by attempt ID. */
export class PackageExperimentLedger {
  constructor(private readonly db: Database.Database, private readonly now = Date.now) {
    const id = db.pragma('application_id', { simple: true })
    const version = db.pragma('user_version', { simple: true })
    if (id !== applicationId) {
      const tables = db.prepare('SELECT name FROM sqlite_master WHERE name NOT LIKE \'sqlite_%\'').all()
      if (id !== 0 || version !== 0 || tables.length) throw new Error('Refusing a non-experiment database')
      db.pragma(`application_id = ${applicationId}`)
    }
    else if (version !== 0 && version !== 1) throw new Error('Unsupported experiment ledger version')
    migrate(drizzle(db), { migrationsFolder: fileURLToPath(new URL('../../src/db/package-experiment-migrations', import.meta.url)) })
    db.pragma('user_version = 1')
  }

  createStudy(input: unknown) {
    const study = packageStudySchema.parse(input)
    const hash = dataHash(study)
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM package_studies WHERE hash = ?').get(hash) as StudyRow | undefined
      if (existing) return { id: existing.id, hash, study }
      const id = randomUUID()
      this.db.prepare('INSERT INTO package_studies VALUES (?, ?, ?)').run(id, hash, JSON.stringify(study))
      return { id, hash, study }
    }).immediate()
  }

  reserveTrial(input: unknown, idempotencyKey: string) {
    const request = trialRequestSchema.parse(input)
    key.parse(idempotencyKey)
    const requestHash = configHash(request)
    const study = this.study(request.studyId)
    if (!study.nights.some(night => night.split === request.split)) throw new Error('Selected split has no nights')
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM package_trials WHERE idempotency_key = ?').get(idempotencyKey) as TrialRow | undefined
      if (previous) {
        if (previous.request_hash !== requestHash) throw new Error('Trial idempotency conflict')
        return previous.id
      }
      const id = randomUUID()
      this.db.prepare('INSERT INTO package_trials(id, idempotency_key, request_hash, request, state) VALUES (?, ?, ?, ?, \'pending\')').run(id, idempotencyKey, requestHash, JSON.stringify(request))
      return id
    }).immediate()
  }

  study(id: string) {
    const row = this.db.prepare('SELECT * FROM package_studies WHERE id = ?').get(id) as StudyRow | undefined
    if (!row) throw new Error('Unknown experiment study')
    const study = packageStudySchema.parse(JSON.parse(row.payload))
    if (dataHash(study) !== row.hash) throw new Error('Study integrity mismatch')
    return study
  }

  trial(id: string) {
    const row = this.db.prepare('SELECT * FROM package_trials WHERE id = ?').get(id) as TrialRow | undefined
    if (!row) throw new Error('Unknown package trial')
    const request = trialRequestSchema.parse(JSON.parse(row.request))
    if (configHash(request) !== row.request_hash) throw new Error('Trial integrity mismatch')
    return { ...row, request }
  }

  /** Exposure is committed before opening any selected input. Failed or expired
   * attempts remain exposures; changing study/input/reference hashes cannot
   * erase prior use of an overlapping night for the same subject and side. */
  claim(trialId: string, leaseMs: number) {
    z.number().int().min(1000).max(3600000).parse(leaseMs)
    return this.db.transaction(() => {
      const trial = this.trial(trialId), now = this.now()
      if (trial.state === 'succeeded') throw new Error('Trial already completed; reuse its report')
      if (trial.state === 'running' && (trial.lease_until ?? 0) > now) throw new Error('Trial already leased')
      const study = this.study(trial.request.studyId)
      const nights = study.nights.filter(night => night.split === trial.request.split)
      const priorExposures = nights.map(night => ({ nightId: night.id, count: (this.db.prepare(`SELECT COUNT(DISTINCT attempt_id) AS count FROM package_exposures
        WHERE subject_id = ? AND side = ? AND start_ms < ? AND end_ms > ?`).get(study.subjectId, study.side, night.endMs, night.startMs) as { count: number }).count }))
      const attemptId = randomUUID()
      for (const night of nights) this.db.prepare('INSERT INTO package_exposures VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(attemptId, trialId, night.id, study.subjectId, study.side, night.startMs, night.endMs, trial.request.split, now)
      this.db.prepare('UPDATE package_trials SET state = \'running\', attempt_id = ?, lease_until = ?, report_hash = NULL WHERE id = ?').run(attemptId, now + leaseMs, trialId)
      return { trialId, attemptId, priorExposures, unexposedHoldoutAtClaim: trial.request.split === 'holdout' && priorExposures.every(night => night.count === 0) }
    }).immediate()
  }

  /** Recomputed when evidence is reviewed; never rely on the claim-time flag
   * after other experiments have accessed overlapping nights. */
  currentEvidence(trialId: string) {
    return this.db.transaction(() => {
      const trial = this.trial(trialId)
      const study = this.study(trial.request.studyId)
      const otherExposures = study.nights.filter(night => night.split === trial.request.split).map(night => ({ nightId: night.id,
        count: (this.db.prepare(`SELECT COUNT(DISTINCT attempt_id) AS count FROM package_exposures
          WHERE subject_id = ? AND side = ? AND start_ms < ? AND end_ms > ? AND attempt_id != ?`).get(study.subjectId, study.side, night.endMs, night.startMs, trial.attempt_id ?? '') as { count: number }).count }))
      return { trialId, state: trial.state, reportHash: trial.report_hash, otherExposures,
        uniqueHoldoutAttempt: trial.state === 'succeeded' && trial.request.split === 'holdout' && otherExposures.every(night => night.count === 0) }
    }).deferred()
  }

  renew(lease: PackageTrialLease, leaseMs: number) {
    z.number().int().min(1000).max(3600000).parse(leaseMs)
    const now = this.now()
    if (this.db.prepare('UPDATE package_trials SET lease_until = ? WHERE id = ? AND attempt_id = ? AND state = \'running\' AND lease_until > ?').run(now + leaseMs, lease.trialId, lease.attemptId, now).changes !== 1) throw new Error('Stale trial lease')
  }

  finish(lease: PackageTrialLease, status: 'succeeded' | 'failed', reportHash: string | null) {
    z.enum(['succeeded', 'failed']).parse(status)
    if (status === 'succeeded' || reportHash !== null) hash.parse(reportHash)
    if (this.db.prepare('UPDATE package_trials SET state = ?, report_hash = ?, lease_until = NULL WHERE id = ? AND attempt_id = ? AND state = \'running\' AND lease_until > ?').run(status, reportHash, lease.trialId, lease.attemptId, this.now()).changes !== 1) throw new Error('Stale trial lease')
  }
}
