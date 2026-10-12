'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Moon, Plus, RotateCcw, X } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, GhostIcon, InlineError, SelectValue, SettingRow, Skeleton, StageBar, Toggle } from '@/src/components/ds'
import {
  SLEEP_STAGES,
  STAGE_METRICS,
  STAGE_METRIC_LABELS,
  STAGE_METRIC_UNITS,
  STAGE_OPERATORS,
  stageRulesetSchema,
  type StageCondition,
  type StageRule,
  type StageRuleset,
  type StageTransition,
} from '@/src/lib/sleep-stage-rules'
import type { SleepStage } from '@/src/lib/sleep-stages'
import { NumberField, SectionColumns, SideTabs } from './SettingsLayout'

type Side = 'left' | 'right'

const STAGE_LABELS: Record<SleepStage, string> = { wake: 'Wake', light: 'Light', deep: 'Deep', rem: 'REM' }
const STAGE_OPTIONS = SLEEP_STAGES.map(s => ({ value: s, label: STAGE_LABELS[s] }))
const METRIC_OPTIONS = STAGE_METRICS.map(m => ({ value: m, label: STAGE_METRIC_LABELS[m] }))
const OP_OPTIONS = STAGE_OPERATORS.map(o => ({ value: o, label: o }))

const NEW_CONDITION: StageCondition = { metric: 'movement', op: '>', value: 100 }

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

const sameRuleset = (a: StageRuleset, b: StageRuleset) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Sleep stage rules for one side: the ordered rules that turn each epoch's
 * heart rate, HRV, breathing and movement into wake/light/deep/REM, plus the
 * outlier limits, smoothing and transition constraints around them. Changes
 * preview against a recent night before saving.
 */
export function SleepStageRules({ side, onSideChange }: { side: Side, onSideChange: (side: Side) => void }) {
  const utils = trpc.useUtils()
  const query = trpc.sleepStages.getClassifier.useQuery({ side }, {
    refetchInterval: query => query.state.data?.pending ? 5000 : false,
  })
  const save = trpc.sleepStages.setClassifier.useMutation({
    onSuccess: () => utils.sleepStages.getClassifier.invalidate({ side }),
  })

  const saved = query.data?.pending?.classifier.ruleset ?? query.data?.classifier.ruleset
  const [draft, setDraft] = useState<StageRuleset | null>(null)
  // Re-seed the draft when the side or its stored ruleset changes — by value,
  // so a background refetch of the same rules keeps unsaved edits.
  const seed = saved ? `${side}:${JSON.stringify(saved)}` : null
  const [seeded, setSeeded] = useState<string | null>(null)
  if (seed !== seeded) {
    setSeeded(seed)
    setDraft(saved ?? null)
  }

  if (query.error) {
    return (
      <Card>
        <InlineError>{`Failed to load sleep stage rules: ${query.error.message}`}</InlineError>
      </Card>
    )
  }
  if (!draft || !query.data) {
    return <SectionColumns left={<Skeleton className="h-[320px]" />} right={<Skeleton className="h-[200px]" />} />
  }

  const { isDefault, presets } = query.data
  const dirty = saved !== undefined && !sameRuleset(draft, saved)
  const validation = stageRulesetSchema.safeParse(draft)
  const update = (patch: Partial<StageRuleset>) => setDraft({ ...draft, ...patch })

  return (
    <SectionColumns
      left={(
        // Freeze the editor while a save is in flight: the refetch it triggers
        // re-seeds the draft, which would silently drop edits typed meanwhile.
        <fieldset disabled={save.isPending} className="contents">
          <Card>
            <CardHeader
              icon={Moon}
              title="Stage rules"
              subtitle="Each 5-minute epoch takes the stage of the first rule whose conditions all hold. Stages are worked out when a night is shown, so applied changes re-score past nights too."
            />
            <SideTabs side={side} onChange={onSideChange} label="Stage rules" />
            {query.data.pending && (
              <p role="status" className="px-4 py-2 text-sm">
                Saved change
                {' '}
                {query.data.pending.generation}
                ; waiting for processor adoption. Displayed nights still use the acknowledged rules.
              </p>
            )}
            {(query.data.pending?.warning ?? query.data.provenance?.warning) && (
              <InlineError>{query.data.pending?.warning ?? query.data.provenance?.warning}</InlineError>
            )}
            <SettingRow label={isDefault ? 'Using the default rules' : 'Using custom rules'}>
              <SelectValue
                label="Start from preset"
                value=""
                options={[{ value: '', label: 'Load preset…' }, ...presets.map(p => ({ value: p.id, label: p.label }))]}
                onChange={(id) => {
                  const preset = presets.find(p => p.id === id)
                  if (preset) setDraft(preset.classifier.ruleset)
                }}
              />
            </SettingRow>
            <RuleList rules={draft.rules} onChange={rules => update({ rules })} />
            <SettingRow label="Otherwise">
              <SelectValue label="Fallback stage" value={draft.fallback} options={STAGE_OPTIONS} onChange={fallback => update({ fallback })} />
            </SettingRow>
            {!validation.success && (
              <InlineError>{validation.error.issues[0]?.message ?? 'These rules are not valid'}</InlineError>
            )}
            {save.error && <InlineError>{save.error.message}</InlineError>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={!dirty || !validation.success || save.isPending}
                onClick={() => save.mutate({ side, classifier: { engine: 'rules', ruleset: draft } })}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button disabled={!dirty} onClick={() => saved && setDraft(saved)}>Discard</Button>
              <Button
                variant="ghost"
                icon={RotateCcw}
                className="ml-auto"
                disabled={isDefault || save.isPending}
                onClick={() => save.mutate({ side, classifier: null })}
              >
                Reset to default
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Signal handling"
              subtitle="Readings outside these limits are ignored. When the piezo calibration quality is low, the low-signal rules replace the rules above."
            />
            <RangeRow label="Heart rate (bpm)" range={draft.outliers.heartRate} onChange={heartRate => update({ outliers: { ...draft.outliers, heartRate } })} />
            <RangeRow label="HRV (ms)" range={draft.outliers.hrv} onChange={hrv => update({ outliers: { ...draft.outliers, hrv } })} />
            <RangeRow label="Breathing (br/min)" range={draft.outliers.breathingRate} onChange={breathingRate => update({ outliers: { ...draft.outliers, breathingRate } })} />
            <SettingRow label="Drop heart-rate spikes beyond (std devs, 0 = off)">
              <NumberField
                label="Heart-rate spike threshold"
                value={draft.outliers.heartRateSpikeStdDevs}
                min={0}
                max={10}
                step={0.5}
                onChange={heartRateSpikeStdDevs => update({ outliers: { ...draft.outliers, heartRateSpikeStdDevs } })}
              />
            </SettingRow>
            <SettingRow label="Low signal below calibration quality">
              <NumberField label="Low-signal threshold" value={draft.lowSignalBelow} min={0} max={1} step={0.05} onChange={lowSignalBelow => update({ lowSignalBelow })} />
            </SettingRow>
            <RuleList rules={draft.lowSignalRules} onChange={lowSignalRules => update({ lowSignalRules })} label="Low-signal rule" />
            <SettingRow label="Smooth single-epoch blips (A-B-A → A-A-A)">
              <Toggle label="Smooth single-epoch blips" on={draft.smoothIsolatedEpochs} onChange={smoothIsolatedEpochs => update({ smoothIsolatedEpochs })} />
            </SettingRow>
            <TransitionList transitions={draft.transitions} onChange={transitions => update({ transitions })} />
          </Card>
        </fieldset>
      )}
      right={<StagePreview side={side} ruleset={validation.success ? validation.data : null} />}
    />
  )
}

export function RuleList({ rules, onChange, label = 'Rule' }: { rules: StageRule[], onChange: (rules: StageRule[]) => void, label?: string }) {
  const setRule = (i: number, rule: StageRule) => onChange(rules.map((r, j) => (j === i ? rule : r)))
  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-ctl border border-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-fg-3">{i + 1}</span>
            <SelectValue label={`${label} ${i + 1} stage`} value={rule.stage} options={STAGE_OPTIONS} onChange={stage => setRule(i, { ...rule, stage })} />
            <span className="text-[13px] text-fg-2">{rule.when.length === 0 ? 'always' : 'when'}</span>
            <span className="ml-auto flex items-center gap-1">
              <GhostIcon icon={ArrowUp} label={`Move ${label.toLowerCase()} ${i + 1} up`} disabled={i === 0} onClick={() => onChange(move(rules, i, i - 1))} />
              <GhostIcon icon={ArrowDown} label={`Move ${label.toLowerCase()} ${i + 1} down`} disabled={i === rules.length - 1} onClick={() => onChange(move(rules, i, i + 1))} />
              <GhostIcon icon={X} label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rules.filter((_, j) => j !== i))} />
            </span>
          </div>
          {rule.when.map((c, k) => (
            <div key={k} className="flex flex-wrap items-center gap-2 pl-3">
              <span className="flex items-center gap-2">
                <span className="w-6 text-xs text-fg-3">{k > 0 ? 'and' : ''}</span>
                <SelectValue
                  label={`${label} ${i + 1} condition ${k + 1} metric`}
                  value={c.metric}
                  options={METRIC_OPTIONS}
                  onChange={metric => setRule(i, { ...rule, when: rule.when.map((x, m) => (m === k ? { ...x, metric } : x)) })}
                />
              </span>
              <span className="flex items-center gap-2 max-[519px]:pl-8">
                <SelectValue
                  label={`${label} ${i + 1} condition ${k + 1} comparison`}
                  value={c.op}
                  options={OP_OPTIONS}
                  onChange={op => setRule(i, { ...rule, when: rule.when.map((x, m) => (m === k ? { ...x, op } : x)) })}
                />
                <NumberField
                  label={`${label} ${i + 1} condition ${k + 1} value`}
                  value={c.value}
                  step={c.metric === 'hrRatio' ? 0.01 : 1}
                  onChange={value => setRule(i, { ...rule, when: rule.when.map((x, m) => (m === k ? { ...x, value } : x)) })}
                />
                {STAGE_METRIC_UNITS[c.metric] && <span className="text-xs text-fg-3">{STAGE_METRIC_UNITS[c.metric]}</span>}
                <GhostIcon
                  icon={X}
                  label={`Remove ${label.toLowerCase()} ${i + 1} condition ${k + 1}`}
                  onClick={() => setRule(i, { ...rule, when: rule.when.filter((_, m) => m !== k) })}
                />
              </span>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            className="self-start"
            disabled={rule.when.length >= 8}
            onClick={() => setRule(i, { ...rule, when: [...rule.when, NEW_CONDITION] })}
          >
            Condition
          </Button>
        </div>
      ))}
      <Button
        variant="dashed"
        size="sm"
        icon={Plus}
        disabled={rules.length >= 32}
        onClick={() => onChange([...rules, { stage: 'wake', when: [NEW_CONDITION] }])}
      >
        {label}
      </Button>
    </div>
  )
}

export function RangeRow({ label, range, onChange }: {
  label: string
  range: { min: number, max: number }
  onChange: (range: { min: number, max: number }) => void
}) {
  return (
    <SettingRow label={label}>
      <span className="flex items-center gap-1.5">
        <NumberField label={`${label} minimum`} value={range.min} onChange={min => onChange({ ...range, min })} />
        <span className="text-fg-3">–</span>
        <NumberField label={`${label} maximum`} value={range.max} onChange={max => onChange({ ...range, max })} />
      </span>
    </SettingRow>
  )
}

export function TransitionList({ transitions, onChange }: { transitions: StageTransition[], onChange: (t: StageTransition[]) => void }) {
  const set = (i: number, t: StageTransition) => onChange(transitions.map((x, j) => (j === i ? t : x)))
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-fg-2">Transitions that must pass through another stage</span>
      {transitions.map((t, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2">
            <SelectValue label={`Transition ${i + 1} from`} value={t.from} options={STAGE_OPTIONS} onChange={from => set(i, { ...t, from })} />
            <span className="text-fg-3">→</span>
            <SelectValue label={`Transition ${i + 1} to`} value={t.to} options={STAGE_OPTIONS} onChange={to => set(i, { ...t, to })} />
          </span>
          <span className="flex items-center gap-2">
            <span className="text-xs text-fg-3">via</span>
            <SelectValue label={`Transition ${i + 1} via`} value={t.via} options={STAGE_OPTIONS} onChange={via => set(i, { ...t, via })} />
            <GhostIcon icon={X} label={`Remove transition ${i + 1}`} onClick={() => onChange(transitions.filter((_, j) => j !== i))} />
          </span>
        </div>
      ))}
      <Button
        variant="dashed"
        size="sm"
        icon={Plus}
        disabled={transitions.length >= 16}
        onClick={() => onChange([...transitions, { from: 'wake', to: 'deep', via: 'light' }])}
      >
        Transition
      </Button>
    </div>
  )
}

const pct = (x: number) => `${Math.round(x * 100)}%`

/** Last night classified with the saved rules and with the draft. */
function StagePreview({ side, ruleset }: { side: Side, ruleset: StageRuleset | null }) {
  const preview = trpc.sleepStages.previewClassifier.useMutation()
  const { mutate } = preview
  const key = useMemo(() => (ruleset ? JSON.stringify(ruleset) : null), [ruleset])

  useEffect(() => {
    if (!key) return
    const t = setTimeout(() => mutate({ side, classifier: { engine: 'rules', ruleset: JSON.parse(key) as StageRuleset } }), 400)
    return () => clearTimeout(t)
  }, [side, key, mutate])

  const data = preview.data
  return (
    <Card>
      <CardHeader
        title="Preview"
        subtitle={data?.enteredBedAt
          ? `Latest night, ${new Date(data.enteredBedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
          : 'Latest night'}
      />
      {preview.error && <InlineError>{preview.error.message}</InlineError>}
      {!data && !preview.error && <Skeleton className="h-[96px]" />}
      {data && !data.saved && !data.candidate && <span className="text-[13px] text-fg-2">No night with vitals to preview yet.</span>}
      {data && (data.saved || data.candidate) && (
        <>
          <PreviewRow label="Saved" stages={data.saved} />
          <PreviewRow label="These rules" stages={data.candidate} />
          {!data.hasReference && (
            <span className="text-xs text-fg-3">Import Apple Watch stages from the iOS app to see how closely each set of rules agrees with it.</span>
          )}
        </>
      )}
    </Card>
  )
}

function PreviewRow({ label, stages }: {
  label: string
  stages: { distribution: Record<SleepStage, number>, qualityScore: number, agreement: { accuracy: number, kappa: number | null } | null } | null
}) {
  if (!stages) return null
  const d = stages.distribution
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-fg-2">{`Q ${stages.qualityScore}`}</span>
        {stages.agreement && (
          <span className="ml-auto font-mono text-xs text-fg-2">
            {`Watch ${pct(stages.agreement.accuracy)}`}
            {stages.agreement.kappa !== null && ` · κ ${stages.agreement.kappa.toFixed(2)}`}
          </span>
        )}
      </div>
      <StageBar awake={d.wake} rem={d.rem} light={d.light} deep={d.deep} />
      <span className="font-mono text-xs text-fg-3">
        {`Wake ${d.wake}% · REM ${d.rem}% · Light ${d.light}% · Deep ${d.deep}%`}
      </span>
    </div>
  )
}
