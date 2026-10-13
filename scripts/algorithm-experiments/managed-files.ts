import { withExperimentWorkspace, defaultWorkspacePolicy } from './workspace'
import { assessManagedQualification } from './qualification'
import Database from 'better-sqlite3'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { packageStudySchema, PackageExperimentLedger } from './ledger'
import { managedProtocolSchema, runManagedTrial } from './managed'
import { experimentPolicySchema } from './policy'
import { readJsonFile, readJsonLines, readPackageProposal } from './files'

const sourcePath = z.string().min(1).max(4096)
export const managedDescriptorSchema = z.object({ schema: z.literal('biometric-managed-descriptor-v1'),
  study: packageStudySchema, protocol: managedProtocolSchema, split: z.enum(['tuning', 'validation', 'holdout']),
  preflightSuite: sourcePath.optional(),
  idempotencyKey: z.string().min(1).max(200),
  variants: z.array(z.object({ label: z.enum(['default', 'current', 'candidate']), proposal: sourcePath,
    config: z.record(z.string(), z.unknown()), seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), policy: experimentPolicySchema }).strict()).length(3),
  nights: z.array(z.object({ id: z.string().min(1).max(200), frames: sourcePath, referenceImport: sourcePath }).strict()).min(1).max(60),
}).strict().superRefine((value, context) => {
  if (Boolean(value.protocol.preflightPlan) !== Boolean(value.preflightSuite)) context.addIssue({ code: 'custom', message: 'Preflight plan and suite must be supplied together' })
  if (new Set(value.variants.map(variant => variant.label)).size !== 3) context.addIssue({ code: 'custom', message: 'All three variants are required' })
  const selected = value.study.nights.filter(night => night.split === value.split)
  if (new Set(value.nights.map(night => night.id)).size !== value.nights.length || selected.length !== value.nights.length
    || selected.some(night => !value.nights.some(source => source.id === night.id))) context.addIssue({ code: 'custom', message: 'Night sources must exactly match the selected split' })
  if (configHash(value.protocol) !== value.study.protocolHash) context.addIssue({ code: 'custom', message: 'Study protocol hash mismatch' })
})

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('Experiment workspace must be a private owned directory, not a symlink')
}

/** CLI storage boundary. Candidate bytes never choose this workspace or its
 * database path; the operator passes the dedicated private workspace argument. */
export async function runManagedFiles(workspace: string, descriptorPath: string, storagePolicy: unknown = defaultWorkspacePolicy) {
  const descriptor = managedDescriptorSchema.parse(readJsonFile(descriptorPath, 2 * 1024 * 1024))
  const base = dirname(resolve(descriptorPath))
  const variants = descriptor.variants.map((variant) => {
    const proposal = readPackageProposal(resolve(base, variant.proposal))
    return { ...variant, manifest: proposal.manifest, files: proposal.files, packageHash: proposal.packageHash }
  })
  await privateDirectory(workspace)
  return withExperimentWorkspace(workspace, storagePolicy, async (owned) => {
    const reports = join(workspace, 'reports')
    await privateDirectory(reports)
    const databasePath = join(workspace, 'experiments.sqlite')
    // Refuse symlinked SQLite files and sidecars before opening SQLite. The
    // private owned directory excludes mutation by candidate/other-user code.
    for (const path of [databasePath, databasePath + '-wal', databasePath + '-shm', databasePath + '-journal']) {
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe experiment database file')
      }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      }
    }
    try {
      const created = await open(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      await created.close()
    }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const db = new Database(databasePath)
    try {
      owned.configureDatabase(db)
      const ledger = new PackageExperimentLedger(db)
      const study = ledger.createStudy(descriptor.study)
      const trialId = ledger.reserveTrial({ studyId: study.id, split: descriptor.split,
        variants: variants.map(variant => ({ label: variant.label, packageHash: variant.packageHash,
          configHash: configHash({ config: variant.config, seed: variant.seed }), image: variant.policy.image })) }, descriptor.idempotencyKey)
      const maximumInputBytes = Math.min(...variants.map(variant => variant.policy.maximumInputBytes))
      const result = await runManagedTrial({ ledger, trialId, protocol: descriptor.protocol, variants, reportDirectory: reports, publishReport: owned.publishReport,
        preflightSuite: descriptor.preflightSuite && ledger.trial(trialId).state !== 'succeeded' ? readJsonFile(resolve(base, descriptor.preflightSuite), 32 * 1024 * 1024) : undefined,
        loadNight: async (id) => {
          await owned.checkCapacity()
          const source = descriptor.nights.find(night => night.id === id)
          if (!source) throw new Error('Missing retained night source')
          return { referenceImport: readJsonFile(resolve(base, source.referenceImport), 2 * 1024 * 1024),
            frames: () => readJsonLines(resolve(base, source.frames), maximumInputBytes) }
        } })
      const reviewed = assessManagedQualification(ledger, trialId, reports)
      return { schema: 'biometric-managed-receipt-v1' as const, studyId: study.id, trialId, ...result,
        currentEvidence: reviewed.currentEvidence, accuracy: reviewed.qualification.accuracy, preflight: reviewed.qualification.preflight,
        qualification: reviewed.qualification, assessmentHash: reviewed.assessmentHash, reportFile: join(reports, `${result.reportHash}.json`) }
    }
    finally { db.close() }
  })
}
