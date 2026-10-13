'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, SelectValue, SettingRow, Toggle } from '@/src/components/ds'
import { AddRuleButton, RuleList, TransitionsRow } from '@/src/components/Settings/SleepStageRows'
import { NumberField } from '@/src/components/Settings/SettingsLayout'
import { SLEEP_STAGES, type StageRuleset } from '@/src/lib/sleep-stage-rules'

export function CandidateStageFields({ ruleset, overrides, onChange }: { ruleset: StageRuleset, overrides: { path: string, value: unknown }[], onChange: (path: string, value: unknown) => void }) {
  const { t } = useLingui()
  const [editing, setEditing] = useState<string | null>(null)
  const ruleProps = { editingKey: editing, onEdit: setEditing, stats: null, hitCaption: '', ranges: {}, seenLabel: '' }
  const stageOverrides = overrides.filter(item => item.path.startsWith('sleep_stages.'))
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer"><Trans>Candidate sleep-stage rules</Trans></summary>
      <p><Trans>These edits belong only to the candidate. Rule order matters: the first matching rule wins.</Trans></p>
      <RuleList {...ruleProps} label={t`Candidate rule`} rules={ruleset.rules} onChange={rules => onChange('sleep_stages.ruleset.rules', rules)} />
      <AddRuleButton label={t`Candidate rule`} rules={ruleset.rules} onChange={rules => onChange('sleep_stages.ruleset.rules', rules)} onEdit={setEditing} />
      <SettingRow label={<Trans>Fallback stage</Trans>}><SelectValue label={t`Fallback stage`} value={ruleset.fallback} options={SLEEP_STAGES.map(stage => ({ value: stage, label: stage }))} onChange={value => onChange('sleep_stages.ruleset.fallback', value)} /></SettingRow>
      {(['heartRate', 'hrv', 'breathingRate'] as const).map(metric => (
        <RangeRow
          key={metric}
          label={metric}
          range={ruleset.outliers[metric]}
          onChange={(range) => {
            if (range.min !== ruleset.outliers[metric].min) onChange(`sleep_stages.ruleset.outliers.${metric}.min`, range.min)
            if (range.max !== ruleset.outliers[metric].max) onChange(`sleep_stages.ruleset.outliers.${metric}.max`, range.max)
          }}
        />
      ))}
      <SettingRow label={<Trans>Heart-rate spike threshold (standard deviations)</Trans>}><NumberField label={t`Candidate spike threshold`} value={ruleset.outliers.heartRateSpikeStdDevs} min={0} max={10} step={0.5} onChange={value => onChange('sleep_stages.ruleset.outliers.heartRateSpikeStdDevs', value)} /></SettingRow>
      <SettingRow label={<Trans>Low-signal calibration quality threshold</Trans>}><NumberField label={t`Candidate low-signal threshold`} value={ruleset.lowSignalBelow} min={0} max={1} step={0.05} onChange={value => onChange('sleep_stages.ruleset.lowSignalBelow', value)} /></SettingRow>
      <RuleList {...ruleProps} rules={ruleset.lowSignalRules} label={t`Candidate low-signal rule`} onChange={value => onChange('sleep_stages.ruleset.lowSignalRules', value)} />
      <AddRuleButton label={t`Candidate low-signal rule`} rules={ruleset.lowSignalRules} onChange={rules => onChange('sleep_stages.ruleset.lowSignalRules', rules)} onEdit={setEditing} />
      <Toggle label={t`Smooth isolated epochs`} on={ruleset.smoothIsolatedEpochs} onChange={value => onChange('sleep_stages.ruleset.smoothIsolatedEpochs', value)} />
      <TransitionsRow editing={editing === 'transitions'} onEdit={on => setEditing(on ? 'transitions' : null)} fixes={null} seenLabel="" transitions={ruleset.transitions} onChange={value => onChange('sleep_stages.ruleset.transitions', value)} />
      <p><Trans>Explicit stage overrides</Trans></p>
      {stageOverrides.length === 0
        ? <p><Trans>Inherited default</Trans></p>
        : (
            <ul className="space-y-2">
              {stageOverrides.map(override => (
                <li key={override.path} className="space-y-1">
                  <span className="break-all font-mono text-xs">{override.path}</span>
                  {' '}
                  <Button onClick={() => onChange(override.path, undefined)}><Trans>Remove stage override</Trans></Button>
                </li>
              ))}
            </ul>
          )}
    </details>
  )
}

function RangeRow({ label, range, onChange }: {
  label: string
  range: { min: number, max: number }
  onChange: (range: { min: number, max: number }) => void
}) {
  return (
    <SettingRow label={label}>
      <NumberField label={`${label} minimum`} value={range.min} onChange={min => onChange({ ...range, min })} />
      <NumberField label={`${label} maximum`} value={range.max} onChange={max => onChange({ ...range, max })} />
    </SettingRow>
  )
}
