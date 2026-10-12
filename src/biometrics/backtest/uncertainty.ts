import { createHash } from 'node:crypto'
import { createNightUncertainty } from './uncertainty-core'
export type { NightBootstrapPolicy } from './uncertainty-policy'
export const nightUncertainty = createNightUncertainty(text => createHash('sha256').update(text).digest())
