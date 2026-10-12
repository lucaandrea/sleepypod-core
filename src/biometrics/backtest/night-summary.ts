import { nightUncertainty } from './uncertainty'
import { createNightSummary } from './night-summary-core'
export const summarizeStageNights = createNightSummary(nightUncertainty)
