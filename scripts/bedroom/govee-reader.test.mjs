import assert from 'node:assert/strict'
import test from 'node:test'
import { receiptQueue } from './govee-reader.mjs'

test('serial publication coalesces pending updates and prioritizes the most recent unavailable receipt', async () => {
  const sent = []
  const states = []
  let finish
  const queue = receiptQueue(async (receipt) => {
    sent.push(receipt)
    if (sent.length === 1) await new Promise((resolve) => {
      finish = resolve
    })
    return { accepted: 4 }
  }, state => states.push(state), () => 100000)
  const first = queue({ observedAt: 99900, reading: { temperatureC: 21 } })
  queue({ observedAt: 99950, reading: { temperatureC: 22 } })
  queue({ observedAt: 100000, reading: null })
  finish()
  await first
  assert.equal(sent.length, 2)
  assert.equal(sent[1].reading, null)
  assert.equal(sent[0].observedAt, 99900)
  assert.equal(states.length, 2)
})

test('a failed or expired receipt is never silently re-timestamped or retried', async () => {
  const sent = []
  const states = []
  const queue = receiptQueue(async (receipt) => {
    sent.push(receipt)
    throw new Error('unreachable')
  },
  state => states.push(state), () => 100000)
  await queue({ observedAt: 100000, reading: {} })
  await queue({ observedAt: 1, reading: {} })
  await queue({ observedAt: 101001, reading: {} })
  assert.equal(sent.length, 1)
  assert.deepEqual(states.map(state => state.error), ['publication_unavailable', 'receipt_expired', 'receipt_expired'])
})
