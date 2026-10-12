import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { canonicalJson, canonicalWithLimit } from '@/src/biometrics/algorithms/canonical-json'
import { createBacktestEvaluator } from '@/src/biometrics/backtest/evaluator-core'
const utf8 = new TextEncoder()
const digest = (text: string) => sha256(utf8.encode(text))
/** Same evaluator and canonical identity as production, with browser hashing. */
export const evaluateDemoBacktest = createBacktestEvaluator({
  configHash: value => bytesToHex(digest(canonicalJson(value))),
  dataHash: value => bytesToHex(digest(canonicalWithLimit(value, 2000000, 32 * 1024 * 1024))),
  digest,
})
