import { TRPCError } from '@trpc/server'
import {
  calculateDistribution,
  calculateQualityScore,
  classifySleepStages,
  mergeIntoBlocks,
  scoreAgainstReference,
} from '@/src/lib/sleep-stages'
import {
  DEFAULT_STAGE_CLASSIFIER,
  STAGE_ENGINES,
  STAGE_RULESET_PRESETS,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'
import { demoMovement, demoNights, demoStageEpochs, demoVitals, findDemoNight, type DemoNight, type Side } from '../history'
import type { DemoHandlers } from '../types'

// Per-tab session state, like the other demo settings.
const saved: Record<Side, StageClassifier | null> = { left: null, right: null }

function previewNight(side: Side, sleepRecordId: number | undefined): DemoNight | undefined {
  if (sleepRecordId === undefined) return demoNights(side)[0]
  const n = findDemoNight(sleepRecordId)
  if (!n || n.side !== side) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${sleepRecordId} not found for side '${side}'` })
  }
  return n
}

export const sleepStages: DemoHandlers<'sleepStages'> = {
  getClassifier: input => ({
    classifier: saved[input.side] ?? DEFAULT_STAGE_CLASSIFIER,
    isDefault: saved[input.side] === null,
    pending: null,
    provenance: { interpretation: 'current_classifier_view', source: 'demo', generation: null, revisionId: null,
      bundleHash: 'demo-simulated', stageHash: 'demo-simulated', manifestHash: null, effectiveSampleTimeMs: null,
      warning: 'Simulated demo classification; no processor activation' },
    defaults: DEFAULT_STAGE_CLASSIFIER,
    engines: Object.entries(STAGE_ENGINES).map(([id, e]) => ({ id, ...e })),
    presets: Object.entries(STAGE_RULESET_PRESETS).map(([id, p]) => ({
      id,
      label: p.label,
      description: p.description,
      classifier: { engine: 'rules' as const, ruleset: p.ruleset },
    })),
  }),

  setClassifier: (input) => {
    saved[input.side] = input.classifier
    return { classifier: input.classifier ?? DEFAULT_STAGE_CLASSIFIER, isDefault: input.classifier === null,
      activation: { generation: 0, revisionId: null, state: 'demo_applied' } }
  },

  // The demo's scripted hypnogram stands in for Apple Watch reference stages.
  previewClassifier: (input) => {
    const n = previewNight(input.side, input.sleepRecordId)
    if (!n) return { sleepRecordId: null, enteredBedAt: null, leftBedAt: null, hasReference: false, saved: null, candidate: null }
    const start = n.enteredBedAt.getTime()
    const end = n.leftBedAt?.getTime() ?? Date.now()
    const vitals = demoVitals(input.side, start, end).map(v => ({ timestamp: new Date(v.t), heartRate: v.heartRate, hrv: v.hrv, breathingRate: v.breathingRate }))
    const movement = demoMovement(input.side, start, end).map(m => ({ timestamp: new Date(m.t), totalMovement: m.score }))
    const reference = mergeIntoBlocks(demoStageEpochs(n, start, end))

    const classify = (classifier: StageClassifier) => {
      const epochs = classifySleepStages(vitals, movement, 1, classifier.ruleset)
      if (epochs.length === 0) return null
      const distribution = calculateDistribution(epochs)
      return {
        blocks: mergeIntoBlocks(epochs),
        distribution,
        qualityScore: calculateQualityScore(distribution),
        totalSleepMs: epochs.reduce((sum, e) => sum + e.duration, 0),
        agreement: scoreAgainstReference(epochs, reference),
      }
    }

    return {
      sleepRecordId: n.id,
      enteredBedAt: start,
      leftBedAt: n.leftBedAt?.getTime() ?? null,
      hasReference: reference.length > 0,
      saved: classify(saved[input.side] ?? DEFAULT_STAGE_CLASSIFIER),
      candidate: classify(input.classifier),
    }
  },
}
