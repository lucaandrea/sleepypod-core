'use client'

import { Trans, useLingui } from '@lingui/react/macro'
import type { ObjectivePolicy } from '@/src/biometrics/backtest/objective-policy'
import type { StageObjectivePolicy } from '@/src/biometrics/backtest/stage-objective'

export function ObjectiveThresholds({ policy, assessments, stage = false }: {
  policy: ObjectivePolicy | StageObjectivePolicy
  assessments?: Array<{ baseline: string, candidate: string, status: string, missingEvidence: string[], failedThresholds: string[] }>
  stage?: boolean
}) {
  const { t } = useLingui()
  const entries = [...Object.entries(policy).filter(([key]) => key !== 'operational'),
    ...Object.entries(policy.operational).filter(([key]) => key !== 'observations'),
    ...Object.entries(policy.operational.observations ?? {}).map(([key, value]) => [`observations.${key}`, value])]
  return (
    <details>
      <summary>{stage ? t`Frozen stage objective thresholds` : t`Frozen objective thresholds`}</summary>
      <p><Trans>Thresholds are part of this experiment. Supplying thresholds does not qualify a promotion policy.</Trans></p>
      {stage ? <p><Trans>Stage agreement is measured against the named reference. It does not establish clinical stage accuracy.</Trans></p> : null}
      <dl className="text-sm">
        {entries.map(([key, value]) => (
          <div key={String(key)}>
            <dt>{String(key)}</dt>
            <dd>{Array.isArray(value) ? value.join(', ') || t`None` : String(value)}</dd>
          </div>
        ))}
      </dl>
      {assessments?.map(assessment => (
        <div key={`${assessment.baseline}:${assessment.candidate}`}>
          <p>
            {assessment.candidate}
            {' / '}
            {assessment.baseline}
            {': '}
            {assessment.status}
          </p>
          {assessment.missingEvidence.map(reason => <p key={reason}>{t`Missing evidence: ${reason}`}</p>)}
          {assessment.failedThresholds.map(reason => <p key={reason}>{t`Threshold failed: ${reason}`}</p>)}
        </div>
      ))}
    </details>
  )
}
