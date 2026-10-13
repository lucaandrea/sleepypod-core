// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PackageExperimentLedger, packageStudySchema } from './ledger'
const start = 1791673200000
function study() {
  return { schema: 'biometric-package-study-v1', subjectId: 'fixture', side: 'left', protocolHash: 'a'.repeat(64), nights: [
    { id: 'night', startMs: start, endMs: start + 28800000, inputHash: 'b'.repeat(64), referenceHash: 'c'.repeat(64), split: 'holdout' },
  ] }
}
function trial(studyId: string, split = 'holdout') {
  return { studyId, split, variants: ['default', 'current', 'candidate'].map(label => ({ label, packageHash: 'd'.repeat(64), configHash: 'e'.repeat(64), image: 'sha256:' + 'f'.repeat(64) })) }
}
let db: Database.Database, ledger: PackageExperimentLedger, now: number
beforeEach(() => {
  db = new Database(':memory:')
  now = 1000
  ledger = new PackageExperimentLedger(db, () => now)
})
afterEach(() => db.close())
describe('dedicated package experiment ledger', () => {
  it('freezes studies and reserves exactly one trial per unchanged request key', () => {
    const first = ledger.createStudy(study())
    expect(ledger.createStudy(study()).id).toBe(first.id)
    const id = ledger.reserveTrial(trial(first.id), 'request')
    expect(ledger.reserveTrial(trial(first.id), 'request')).toBe(id)
    const changed = trial(first.id)
    changed.variants[2].configHash = '0'.repeat(64)
    expect(() => ledger.reserveTrial(changed, 'request')).toThrow('idempotency')
    expect(ledger.currentEvidence(id).uniqueHoldoutAttempt).toBe(false)
  })
  it('records exposure before execution and fences expired workers and their renewals', () => {
    const id = ledger.reserveTrial(trial(ledger.createStudy(study()).id), 'request')
    const first = ledger.claim(id, 1000)
    expect(first.unexposedHoldoutAtClaim).toBe(true)
    expect(() => ledger.claim(id, 1000)).toThrow('leased')
    now = 2000
    const retry = ledger.claim(id, 1000)
    expect(retry).toMatchObject({ unexposedHoldoutAtClaim: false, priorExposures: [{ nightId: 'night', count: 1 }] })
    expect(() => ledger.finish(first, 'succeeded', '1'.repeat(64))).toThrow('Stale')
    expect(() => ledger.renew(first, 1000)).toThrow('Stale')
    ledger.renew(retry, 2000)
    now = 3500
    ledger.finish(retry, 'succeeded', '2'.repeat(64))
    expect(ledger.currentEvidence(id)).toMatchObject({ reportHash: '2'.repeat(64), uniqueHoldoutAttempt: false })
    expect(() => ledger.claim(id, 1000)).toThrow('completed')
  })
  it('detects overlap across changed studies, hashes and splits, including failed attempts', () => {
    const tuning = study()
    tuning.nights[0].split = 'tuning'
    const tuningId = ledger.reserveTrial(trial(ledger.createStudy(tuning).id, 'tuning'), 'tuning')
    ledger.finish(ledger.claim(tuningId, 1000), 'failed', '1'.repeat(64))
    const changed = study()
    changed.nights[0] = { ...changed.nights[0], id: 'renamed', startMs: start + 1000, inputHash: '0'.repeat(64), referenceHash: '1'.repeat(64) }
    const next = ledger.reserveTrial(trial(ledger.createStudy(changed).id), 'new')
    expect(ledger.claim(next, 1000)).toMatchObject({ unexposedHoldoutAtClaim: false, priorExposures: [{ nightId: 'renamed', count: 1 }] })
  })
  it('invalidates a previous first-use claim when later overlapping trials run', () => {
    const studyId = ledger.createStudy(study()).id
    const first = ledger.reserveTrial(trial(studyId), 'first')
    ledger.finish(ledger.claim(first, 1000), 'succeeded', '1'.repeat(64))
    expect(ledger.currentEvidence(first).uniqueHoldoutAttempt).toBe(true)
    const next = ledger.reserveTrial(trial(studyId), 'next')
    ledger.claim(next, 1000)
    expect(ledger.currentEvidence(first).uniqueHoldoutAttempt).toBe(false)
    expect(new PackageExperimentLedger(db, () => now).currentEvidence(first).otherExposures[0].count).toBe(1)
  })
  it('preserves independent sides and disjoint nights', () => {
    const original = ledger.reserveTrial(trial(ledger.createStudy(study()).id), 'original')
    ledger.claim(original, 1000)
    for (const [key, changed] of [['right', { ...study(), side: 'right' }], ['later', { ...study(), nights: study().nights.map(night => ({ ...night, startMs: start + 86400000, endMs: start + 86400000 + 28800000 })) }]] as const) {
      const id = ledger.reserveTrial(trial(ledger.createStudy(changed).id), key)
      expect(ledger.claim(id, 1000).unexposedHoldoutAtClaim).toBe(true)
    }
  })
  it('rejects nonchronological and overlapping split plans', () => {
    const value = study()
    const later = { ...value.nights[0], id: 'later', startMs: start + 86400000, endMs: start + 86400000 + 28800000, split: 'tuning' }
    expect(packageStudySchema.safeParse({ ...value, nights: [...value.nights, later] }).success).toBe(false)
    expect(packageStudySchema.safeParse({ ...value, nights: [...value.nights, { ...value.nights[0], id: 'overlap' }] }).success).toBe(false)
  })
  it('persists exposure and fences competing database connections across reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'package-ledger-test-'))
    const path = join(directory, 'experiments.db')
    const firstDb = new Database(path), secondDb = new Database(path)
    try {
      const first = new PackageExperimentLedger(firstDb, () => now), second = new PackageExperimentLedger(secondDb, () => now)
      const studyId = first.createStudy(study()).id
      const trialId = first.reserveTrial(trial(studyId), 'shared')
      expect(second.reserveTrial(trial(studyId), 'shared')).toBe(trialId)
      const lease = first.claim(trialId, 1000)
      expect(() => second.claim(trialId, 1000)).toThrow('leased')
      now += 1000
      const replacement = second.claim(trialId, 1000)
      expect(() => first.finish(lease, 'succeeded', '1'.repeat(64))).toThrow('Stale')
      second.finish(replacement, 'succeeded', '2'.repeat(64))
      firstDb.close()
      secondDb.close()
      const reopened = new Database(path)
      try {
        expect(new PackageExperimentLedger(reopened).currentEvidence(trialId)).toMatchObject({ uniqueHoldoutAttempt: false, reportHash: '2'.repeat(64) })
      }
      finally { reopened.close() }
    }
    finally {
      if (firstDb.open) firstDb.close()
      if (secondDb.open) secondDb.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('resumes interrupted initial migration branding and rejects unknown future versions', () => {
    db.pragma('user_version = 0')
    expect(() => new PackageExperimentLedger(db)).not.toThrow()
    db.pragma('user_version = 2')
    expect(() => new PackageExperimentLedger(db)).toThrow('Unsupported')
    expect(db.pragma('user_version', { simple: true })).toBe(2)
  })
  it('refuses another application database without changing its schema or data', () => {
    const other = new Database(':memory:')
    try {
      other.exec('CREATE TABLE vitals(value INTEGER); INSERT INTO vitals VALUES (60)')
      expect(() => new PackageExperimentLedger(other)).toThrow('non-experiment')
      expect(other.prepare('SELECT value FROM vitals').get()).toEqual({ value: 60 })
      expect(other.pragma('application_id', { simple: true })).toBe(0)
    }
    finally { other.close() }
  })
})

it('allows a failed attempt without a report while refusing success without evidence', () => {
  const id = ledger.reserveTrial(trial(ledger.createStudy(study()).id), 'missing-report')
  const lease = ledger.claim(id, 1000)
  expect(() => ledger.finish(lease, 'succeeded', null)).toThrow()
  expect(ledger.trial(id).state).toBe('running')
  ledger.finish(lease, 'failed', null)
  expect(ledger.trial(id)).toMatchObject({ state: 'failed', report_hash: null, lease_until: null })
  expect(ledger.claim(id, 1000).unexposedHoldoutAtClaim).toBe(false)
  expect(() => ledger.finish(lease, 'failed', null)).toThrow('Stale')
})
