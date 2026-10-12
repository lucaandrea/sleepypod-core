import { createHash } from 'node:crypto'
import { configHash, dataHash } from '../algorithms/canonical'
import { createBacktestEvaluator } from './evaluator-core'
export { backtestWorkSchema, waveformEvaluationSchema } from './evaluator-core'
export const evaluateBacktest = createBacktestEvaluator({ configHash, dataHash, digest: text => createHash('sha256').update(text).digest() })
