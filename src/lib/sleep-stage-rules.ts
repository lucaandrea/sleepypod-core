/**
 * Sleep stage classification rules as data.
 *
 * The classifier in sleep-stages.ts evaluates a StageRuleset: ordered
 * first-match rules over per-epoch metrics, then smoothing and transition
 * constraints. DEFAULT_STAGE_RULESET reproduces the iOS SleepAnalyzer port;
 * a side may store its own ruleset, validated by stageClassifierSchema at the
 * API boundary. Stages are classified on read, so a changed ruleset re-scores
 * every stored night.
 */
import { z } from 'zod'
import biometricContract from '../../modules/common/biometrics/manifest.v1.json'

export const SLEEP_STAGES = ['wake', 'light', 'deep', 'rem'] as const

/**
 * Per-epoch inputs a rule can test. hrRatio is the epoch's heart rate over
 * the night's mean heart rate. A condition on a metric the epoch lacks
 * (null) never matches.
 */
export const STAGE_METRICS = ['hrRatio', 'heartRate', 'hrv', 'breathingRate', 'movement'] as const
export type StageMetric = typeof STAGE_METRICS[number]

export const STAGE_OPERATORS = ['<', '<=', '>', '>='] as const
export type StageOperator = typeof STAGE_OPERATORS[number]

export const STAGE_METRIC_LABELS: Record<StageMetric, string> = {
  hrRatio: 'HR ratio',
  heartRate: 'Heart rate',
  hrv: 'HRV',
  breathingRate: 'Breathing rate',
  movement: 'Movement',
}

export const STAGE_METRIC_UNITS: Record<StageMetric, string> = {
  hrRatio: '',
  heartRate: 'bpm',
  hrv: 'ms',
  breathingRate: 'br/min',
  movement: '',
}

export interface StageCondition {
  metric: StageMetric
  op: StageOperator
  value: number
}
export interface StageRule {
  stage: typeof SLEEP_STAGES[number]
  when: StageCondition[]
}
export interface StageTransition {
  from: typeof SLEEP_STAGES[number]
  to: typeof SLEEP_STAGES[number]
  via: typeof SLEEP_STAGES[number]
}
export interface StageRuleset {
  outliers: {
    heartRate: { min: number, max: number }
    hrv: { min: number, max: number }
    breathingRate: { min: number, max: number }
    heartRateSpikeStdDevs: number
  }
  lowSignalBelow: number
  lowSignalRules: StageRule[]
  rules: StageRule[]
  fallback: typeof SLEEP_STAGES[number]
  smoothIsolatedEpochs: boolean
  transitions: StageTransition[]
}

// Validation bounds and defaults come from the same artifact Python consumes.
// The legacy API remains a typed Zod adapter over that contract.
const rulesContract = biometricContract.parameters.properties.sleep_stages.properties.ruleset
function contractSchema<T>(schema: unknown): z.ZodType<T, T> {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<T, T>
}
export const stageConditionSchema = contractSchema<StageCondition>(rulesContract.properties.rules.items.properties.when.items)
export const stageRuleSchema = contractSchema<StageRule>(rulesContract.properties.rules.items)
export const stageTransitionSchema = contractSchema<StageTransition>(rulesContract.properties.transitions.items)
export const stageRulesetSchema = contractSchema<StageRuleset>(rulesContract)
  .superRefine((ruleset, context) => {
    for (const path of biometricContract.orderedRanges) {
      const metric = path[3] as keyof Pick<StageRuleset['outliers'], 'heartRate' | 'hrv' | 'breathingRate'>
      if (ruleset.outliers[metric].min > ruleset.outliers[metric].max) {
        context.addIssue({ code: 'custom', path: ['outliers', metric], message: 'min must be less than or equal to max' })
      }
    }
  })

/**
 * How a side's stages are classified. `engine` selects the classifier; the
 * only engine today evaluates a ruleset. A stored null means the defaults.
 */
export const stageClassifierSchema = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('rules'), ruleset: stageRulesetSchema }).strict(),
])
export type StageClassifier = z.infer<typeof stageClassifierSchema>
export type StageEngine = StageClassifier['engine']

export const STAGE_ENGINES: Record<StageEngine, { label: string, description: string }> = {
  rules: {
    label: 'Rules',
    description: 'Ordered threshold rules over heart rate, HRV, breathing and movement',
  },
}

/** The iOS SleepAnalyzer port the pod has always used. */
export const DEFAULT_STAGE_RULESET: StageRuleset = stageRulesetSchema.parse(biometricContract.defaults.sleep_stages.ruleset)

/** Movement only (actigraphy): ignores heart signals entirely. */
export const MOVEMENT_ONLY_STAGE_RULESET: StageRuleset = {
  ...DEFAULT_STAGE_RULESET,
  lowSignalBelow: 0,
  rules: DEFAULT_STAGE_RULESET.lowSignalRules,
}

/**
 * HRV first: stages ordered by HRV alone (deep lowest, REM and wake highest),
 * for pods whose heart-rate estimate tracks the sleeper poorly and makes the
 * HR-ratio rules classify noise. Thresholds come from Apple Watch reference
 * nights on a Pod 5 (median HRV deep 21, light 33, REM 42, wake 50).
 */
export const HRV_FIRST_STAGE_RULESET: StageRuleset = {
  ...DEFAULT_STAGE_RULESET,
  rules: [
    { stage: 'wake', when: [{ metric: 'movement', op: '>', value: 200 }] },
    { stage: 'wake', when: [{ metric: 'hrv', op: '>', value: 55 }] },
    { stage: 'deep', when: [{ metric: 'hrv', op: '<', value: 28 }] },
    { stage: 'rem', when: [{ metric: 'hrv', op: '>', value: 38 }] },
  ],
}

export const STAGE_RULESET_PRESETS = {
  default: { label: 'Default', description: 'Heart rate, HRV and movement (iOS SleepAnalyzer port)', ruleset: DEFAULT_STAGE_RULESET },
  movementOnly: { label: 'Movement only', description: 'Wake or light from movement alone, ignoring heart signals', ruleset: MOVEMENT_ONLY_STAGE_RULESET },
  hrvFirst: { label: 'HRV first', description: 'Stages from HRV alone (deep lowest, REM and wake highest); for pods whose heart-rate estimate tracks the watch poorly', ruleset: HRV_FIRST_STAGE_RULESET },
} as const satisfies Record<string, { label: string, description: string, ruleset: StageRuleset }>
export type StageRulesetPreset = keyof typeof STAGE_RULESET_PRESETS

export const DEFAULT_STAGE_CLASSIFIER: StageClassifier = { engine: 'rules', ruleset: DEFAULT_STAGE_RULESET }

/**
 * The classifier a side uses: its stored one, or the defaults when it has
 * none. A stored value that no longer validates also falls back, so a schema
 * change can never break stage reads.
 */
export function resolveStageClassifier(stored: unknown): StageClassifier {
  if (stored == null) return DEFAULT_STAGE_CLASSIFIER
  const parsed = stageClassifierSchema.safeParse(stored)
  return parsed.success ? parsed.data : DEFAULT_STAGE_CLASSIFIER
}

/** "HR ratio < 0.92" */
export function describeCondition(c: StageCondition): string {
  const unit = STAGE_METRIC_UNITS[c.metric]
  return `${STAGE_METRIC_LABELS[c.metric]} ${c.op} ${c.value}${unit ? ` ${unit}` : ''}`
}

const STAGE_NAMES: Record<SleepStageName, string> = { wake: 'Wake', light: 'Light', deep: 'Deep', rem: 'REM' }
type SleepStageName = typeof SLEEP_STAGES[number]

/** "Wake movement 200 → 240": the first thing that differs, for a change log. */
export function describeRulesetChange(before: StageRuleset, after: StageRuleset): string[] {
  const out: string[] = []
  const range = (r: { min: number, max: number }) => `${r.min}–${r.max}`
  const stageName = (s: SleepStageName) => STAGE_NAMES[s]
  const metric = (m: StageMetric) => STAGE_METRIC_LABELS[m].toLowerCase().replace('hr ratio', 'HR ratio').replace('hrv', 'HRV')

  const diffRules = (a: StageRule[], b: StageRule[], label: string) => {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const ra = a[i]
      const rb = b[i]
      if (!ra || !rb) {
        if (rb) out.push(`Added ${label} ${i + 1}: ${stageName(rb.stage)}`)
        if (ra) out.push(`Removed ${label} ${i + 1}: ${stageName(ra.stage)}`)
        continue
      }
      if (ra.stage !== rb.stage) out.push(`${label[0].toUpperCase()}${label.slice(1)} ${i + 1}: ${stageName(ra.stage)} → ${stageName(rb.stage)}`)
      const m = Math.max(ra.when.length, rb.when.length)
      for (let k = 0; k < m; k++) {
        const ca = ra.when[k]
        const cb = rb.when[k]
        if (!ca || !cb) {
          if (cb) out.push(`${stageName(rb.stage)}: added ${describeCondition(cb).toLowerCase()}`)
          if (ca) out.push(`${stageName(ra.stage)}: removed ${describeCondition(ca).toLowerCase()}`)
          continue
        }
        if (ca.metric !== cb.metric || ca.op !== cb.op) {
          out.push(`${stageName(rb.stage)}: ${describeCondition(ca)} → ${describeCondition(cb)}`)
        }
        else if (ca.value !== cb.value) {
          const unit = STAGE_METRIC_UNITS[cb.metric]
          out.push(`${stageName(rb.stage)} ${metric(cb.metric)} ${ca.value} → ${cb.value}${unit ? ` ${unit}` : ''}`)
        }
      }
    }
  }

  diffRules(before.rules, after.rules, 'rule')
  if (before.fallback !== after.fallback) out.push(`Otherwise ${stageName(before.fallback)} → ${stageName(after.fallback)}`)
  const oa = before.outliers
  const ob = after.outliers
  if (range(oa.heartRate) !== range(ob.heartRate)) out.push(`Heart rate limits ${range(oa.heartRate)} → ${range(ob.heartRate)} bpm`)
  if (range(oa.hrv) !== range(ob.hrv)) out.push(`HRV limits ${range(oa.hrv)} → ${range(ob.hrv)} ms`)
  if (range(oa.breathingRate) !== range(ob.breathingRate)) out.push(`Breathing limits ${range(oa.breathingRate)} → ${range(ob.breathingRate)} br/min`)
  if (oa.heartRateSpikeStdDevs !== ob.heartRateSpikeStdDevs) out.push(`HR spike filter ${oa.heartRateSpikeStdDevs} → ${ob.heartRateSpikeStdDevs} SD`)
  if (before.lowSignalBelow !== after.lowSignalBelow) out.push(`Low signal below ${before.lowSignalBelow} → ${after.lowSignalBelow}`)
  diffRules(before.lowSignalRules, after.lowSignalRules, 'low-signal rule')
  if (before.smoothIsolatedEpochs !== after.smoothIsolatedEpochs) out.push(`Smoothing ${after.smoothIsolatedEpochs ? 'on' : 'off'}`)
  if (JSON.stringify(before.transitions) !== JSON.stringify(after.transitions)) {
    out.push(`Transitions ${before.transitions.length} → ${after.transitions.length}`)
  }
  return out
}

/** One line for a change log: the first difference, plus how many more. */
export function summarizeRulesetChange(before: StageRuleset, after: StageRuleset): string {
  const changes = describeRulesetChange(before, after)
  if (changes.length === 0) return 'No change'
  return changes.length === 1 ? changes[0] : `${changes[0]} +${changes.length - 1} more`
}
