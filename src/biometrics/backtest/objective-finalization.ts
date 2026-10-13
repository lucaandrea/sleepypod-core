import { assessStageObjective, stageObjectivePolicySchema, stageObjectiveEvidenceSchema, type StageObjectivePolicy } from './stage-objective'
import { z } from 'zod'
import { jobOperationsSchema } from './job-operations'
import { assessNumericObjective, objectiveEvidenceSchema, objectivePolicySchema, type ObjectivePolicy, type ObjectiveEvidence } from './objective-policy'

/** Convert supervisor measurements only when this frozen policy explicitly
 * permits sampled RSS. Legacy peak policies do not silently change meaning. */
export function objectiveOperations(raw: unknown, policy: Pick<ObjectivePolicy, 'qualificationId' | 'operational'>): ObjectiveEvidence['operational'] {
  if (!policy.operational.observations) return null
  const parsed = jobOperationsSchema.safeParse(raw)
  if (!parsed.success) return null
  const { wallMs, ingestion, memory } = parsed.data
  if (!memory || !memory.allSamplesAvailable || memory.samples < 2 || memory.samples !== memory.attempts || memory.peakObservedRssBytes === null
    || !ingestion.allChecksMeasured || ingestion.samples < 2 || ingestion.samples !== ingestion.checks
    || ingestion.maximumObservedAgeMs === null || ingestion.qualificationId === null) return null
  return { wallMs, peakRssBytes: memory.peakObservedRssBytes, maximumIngestionAgeMs: ingestion.maximumObservedAgeMs,
    observations: { version: 'sampled-process-group-v1', qualificationId: ingestion.qualificationId,
      maximumMemoryGapMs: memory.maximumObservationGapMs, maximumIngestionGapMs: ingestion.maximumObservationGapMs } }
}
const assessment = z.object({ version: z.literal('numeric-objective-assessment-v1'), policy: objectivePolicySchema,
  evidence: objectiveEvidenceSchema, baseline: z.enum(['default', 'current']), candidate: z.literal('candidate'),
  baselineHash: z.string(), candidateHash: z.string() })

/** Called after final admission, before immutable report publication. Operational
 * evidence from the scoring child is replaced, never trusted as host telemetry. */
export function finalizeObjectiveReport(raw: unknown, policy: ObjectivePolicy | readonly ObjectivePolicy[] | undefined, operations: unknown, designatedPolicy: ObjectivePolicy | readonly ObjectivePolicy[] | null) {
  const report = z.record(z.string(), z.unknown()).parse(raw)
  const policies = policy === undefined ? [] : Array.isArray(policy) ? policy : [policy]
  if (!policies.length) return report
  const parsedPolicies = policies.map(item => objectivePolicySchema.parse(item))
  if (new Set(parsedPolicies.map(item => item.metric)).size !== parsedPolicies.length) throw new Error('Duplicate numeric objective metric')
  const designations = designatedPolicy === null ? [] : Array.isArray(designatedPolicy) ? designatedPolicy : [designatedPolicy]
  const parsedDesignations = designations.map(item => objectivePolicySchema.parse(item))
  if (new Set(parsedDesignations.map(item => item.metric)).size !== parsedDesignations.length) throw new Error('Duplicate numeric policy designation')
  const assessments = z.array(assessment).length(parsedPolicies.length * 2).parse(report.objectiveAssessments)
  const identities = new Set<string>()
  const finalized = assessments.map((row) => {
    const selected = parsedPolicies.find(item => item.metric === row.policy.metric)
    const identity = `${row.policy.metric}:${row.baseline}`
    if (!selected || identities.has(identity) || JSON.stringify(row.policy) !== JSON.stringify(selected)) throw new Error('Objective report identity mismatch')
    identities.add(identity)
    return { baseline: row.baseline, candidate: row.candidate, baselineHash: row.baselineHash, candidateHash: row.candidateHash,
      ...assessNumericObjective(selected, { ...row.evidence, operational: objectiveOperations(operations, selected) },
        parsedDesignations.find(item => item.metric === selected.metric) ?? null) }
  })
  return { ...report, objectiveAssessments: finalized }
}

const stageAssessment = z.object({ version: z.literal('stage-objective-assessment-v1'), policy: stageObjectivePolicySchema,
  evidence: stageObjectiveEvidenceSchema, baseline: z.enum(['default', 'current']), candidate: z.literal('candidate'), baselineHash: z.string(), candidateHash: z.string() })
export function finalizeStageObjectiveReport(raw: unknown, policy: StageObjectivePolicy | undefined, operations: unknown, designation: StageObjectivePolicy | null) {
  const report = z.record(z.string(), z.unknown()).parse(raw)
  if (!policy) return report
  const assessments = z.array(stageAssessment).length(2).parse(report.stageObjectiveAssessments)
  if (new Set(assessments.map(row => row.baseline)).size !== 2
    || assessments.some(row => JSON.stringify(row.policy) !== JSON.stringify(stageObjectivePolicySchema.parse(policy)))) throw new Error('Stage objective report identity mismatch')
  const operational = objectiveOperations(operations, policy)
  return { ...report, stageObjectiveAssessments: assessments.map(row => ({ baseline: row.baseline, candidate: row.candidate,
    baselineHash: row.baselineHash, candidateHash: row.candidateHash,
    ...assessStageObjective(policy, { ...row.evidence, operational }, designation),
  })) }
}
