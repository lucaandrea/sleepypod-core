import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { startGoveeReadLoop } from './govee-read-loop.mjs'

function fixture() {
  let clock = 1793000000000
  let tick
  const client = new EventEmitter()
  const requests = []
  const reports = []
  client.publish = (topic, contents, options, callback) => {
    requests.push({ topic, contents: JSON.parse(contents), options })
    callback()
  }
  client.subscribe = (_topic, _options, callback) => callback()
  client.end = () => {
    client.ended = true
  }
  const loop = startGoveeReadLoop({ client, deviceId: 'test-monitor', deviceTopic: 'device-topic',
    accountTopic: 'account-topic', statusVersion: 0 }, receipt => reports.push(receipt),
  { now: () => clock, repeat: (callback) => {
    tick = callback
    return 1
  }, cancel: () => {} })
  return { client, requests, reports, loop, advance: (milliseconds) => {
    clock += milliseconds
    tick()
  },
  reply(changes = {}, packet = { retain: false, dup: false, qos: 0 }) {
    const payload = { cmd: 'status', sku: 'H5106', device: 'test-monitor',
      transaction: requests.at(-1).contents.msg.transaction,
      op: { command: ['CGYAAAAAAAAAFdYAAAAAAAAAAAA=', 'AQMAAAAAAAAAAAAAAAAAAAAAAAA=', 'AQAAAAAAAAAAAAAAAAAAAAAAAAA='] }, ...changes }
    client.emit('message', 'account-topic', Buffer.from(JSON.stringify(payload)), packet)
  } }
}

test('issues only status reads and delivers a newly correlated reading once', async () => {
  const state = fixture()
  state.client.emit('connect')
  assert.deepEqual(state.requests[0], { topic: 'device-topic', contents: { msg: {
    cmd: 'status', cmdVersion: 0, transaction: 'v_1793000000000000', type: 0, accountTopic: 'account-topic',
  } }, options: { qos: 0, retain: false } })
  state.advance(900)
  state.reply()
  state.reply()
  assert.equal(state.reports.length, 1)
  assert.equal(state.reports[0].reading.temperatureC, 21.5)
  state.client.emit('offline')
  state.client.emit('close')
  assert.equal(state.reports.length, 2)
  assert.equal(state.reports[1].reading, null)
  await state.loop.stop()
  assert.equal(state.client.ended, true)
})

test('retained/malformed/delayed replies expire and reconnect requires another request', async () => {
  const state = fixture()
  state.client.emit('connect')
  const originalTransaction = state.requests[0].contents.msg.transaction
  state.reply({}, { retain: true, dup: false, qos: 0 })
  state.client.emit('message', 'account-topic', Buffer.from('bad-json'), {})
  state.advance(8001)
  state.reply()
  assert.deepEqual(state.reports.map(receipt => receipt.reading), [null])
  state.client.emit('offline')
  state.client.emit('connect')
  state.reply({ transaction: originalTransaction })
  assert.equal(state.reports.length, 1)
  state.advance(500)
  state.reply()
  assert.equal(state.reports.at(-1).reading.humidity, 55.9)
  state.advance(30000)
  assert.equal(state.requests.length, 3)
  await state.loop.stop()
})

test('a late subscription callback cannot revive a disconnected or stopped session', async () => {
  const state = fixture()
  let subscription
  state.client.subscribe = (_topic, _options, callback) => {
    subscription = callback
  }
  state.client.emit('connect')
  state.client.emit('close')
  subscription()
  assert.equal(state.requests.length, 0)
  state.client.emit('connect')
  await state.loop.stop()
  subscription()
  assert.equal(state.requests.length, 0)
})

test('publish failure withdraws the source without retrying an old request', async () => {
  const state = fixture()
  state.client.publish = (_topic, _contents, _options, callback) => callback(new Error('offline'))
  state.client.emit('connect')
  assert.equal(state.reports.length, 1)
  assert.equal(state.reports[0].reading, null)
  state.advance(1000)
  assert.equal(state.reports.length, 1)
  await state.loop.stop()
})

test('a late failed publish callback cannot cancel a newer pending read', async () => {
  const state = fixture()
  const callbacks = []
  state.client.publish = (topic, contents, options, callback) => {
    state.requests.push({ topic, contents: JSON.parse(contents), options })
    callbacks.push(callback)
  }
  state.client.emit('connect')
  state.advance(900)
  state.reply()
  state.advance(30000)
  callbacks[0](new Error('late error'))
  state.reply()
  assert.equal(state.reports.length, 2)
  assert.ok(state.reports.every(receipt => receipt.reading !== null))
  await state.loop.stop()
})
