import { classifySleepStages } from '@/src/lib/sleep-stages'
import type { StageClassifier } from '@/src/lib/sleep-stage-rules'
import { demoMovement, demoVitals, type Side } from '../history'

/** Synthetic inputs use an explicit demo quality assumption, never a sensor receipt. */
export function classifyDemoWindow(side: Side, start: number, end: number, classifier: StageClassifier) {
  const vitals = demoVitals(side, start, end).map(v => ({ timestamp: new Date(v.t), heartRate: v.heartRate, hrv: v.hrv, breathingRate: v.breathingRate }))
  const movement = demoMovement(side, start, end).map(m => ({ timestamp: new Date(m.t), totalMovement: m.score }))
  return classifySleepStages(vitals, movement, 1, classifier.ruleset)
}
