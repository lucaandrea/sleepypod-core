import type { DemoHandlers } from '../types'
import { COMFORT_ACTIVATION_REASON } from '@/src/comfort/contract'

const unavailable = 'Personal comfort requires a live, authenticated Pod. Demo data is not used for learning or Preview nights.'

/** A demo must not imply that feedback was saved or a real night was evaluated. */
function rejectDemoWrite(): never {
  throw new Error(unavailable)
}

export const comfort: DemoHandlers<'comfort'> = {
  get: ({ side }) => ({
    apiVersion: 1,
    generatedAt: Date.now(),
    side,
    timezone: null,
    deviceDate: null,
    state: null,
    evaluatedAt: null,
    decision: null,
    fault: unavailable,
    history: [],
    runtime: 'stopped',
    activation: { available: false, reason: COMFORT_ACTIVATION_REASON },
    features: { sensorAware: false, followBedtime: false },
  }),
  configure: rejectDemoWrite,
  feedback: rejectDemoWrite,
}
