import { TRPCError } from '@trpc/server'
import {
  calculateDistribution,
  calculateQualityScore,
  mergeIntoBlocks,
  scoreAgainstReference,
} from '@/src/lib/sleep-stages'
import {
  DEFAULT_STAGE_CLASSIFIER,
  STAGE_ENGINES,
  STAGE_RULESET_PRESETS,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'
import { demoNights, demoStageEpochs, findDemoNight, type DemoNight, type Side } from '../history'
import type { DemoHandlers } from '../types'
import { classifyDemoWindow } from '../biometrics/stages'
import { demoStageSettings, demoStageView, writeDemoStageClassifier } from './biometricTuning'

function previewNight(side: Side, sleepRecordId: number | undefined): DemoNight | undefined {
  if (sleepRecordId === undefined) return demoNights(side)[0]
  const n = findDemoNight(sleepRecordId)
  if (!n || n.side !== side) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${sleepRecordId} not found for side '${side}'` })
  }
  return n
}

export const sleepStages: DemoHandlers<'sleepStages'> = {
  getClassifier: async input => ({
    ...await demoStageSettings(input.side),
    defaults: DEFAULT_STAGE_CLASSIFIER,
    engines: Object.entries(STAGE_ENGINES).map(([id, e]) => ({ id, ...e })),
    presets: Object.entries(STAGE_RULESET_PRESETS).map(([id, p]) => ({
      id,
      label: p.label,
      description: p.description,
      classifier: { engine: 'rules' as const, ruleset: p.ruleset },
    })),
  }),

  setClassifier: input => writeDemoStageClassifier(input.side, input.classifier),

  // The demo's scripted hypnogram stands in for Apple Watch reference stages.
  previewClassifier: async (input) => {
    const n = previewNight(input.side, input.sleepRecordId)
    if (!n) return { sleepRecordId: null, enteredBedAt: null, leftBedAt: null, hasReference: false, saved: null, candidate: null }
    const start = n.enteredBedAt.getTime()
    const end = n.leftBedAt?.getTime() ?? Date.now()
    const reference = mergeIntoBlocks(demoStageEpochs(n, start, end))

    const classify = (classifier: StageClassifier) => {
      const epochs = classifyDemoWindow(input.side, start, end, classifier)
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
      saved: classify((await demoStageView(input.side)).classifier),
      candidate: classify(input.classifier),
    }
  },
}
