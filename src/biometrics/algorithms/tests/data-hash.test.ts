import { describe, expect, it } from 'vitest'
import { configHash, dataHash } from '../canonical'

describe('bounded retained-data hashing', () => {
  it('keeps canonical identity while permitting realistic multi-night data beyond config budgets', () => {
    const small = { timestampMs: 1791673200000, heartRate: 60.1 }
    expect(dataHash(small)).toBe(configHash(small))
    const large = Array.from({ length: 10000 }, (_, id) => ({ id, ...small }))
    expect(() => configHash(large)).toThrow('resource limit')
    expect(dataHash(large)).toMatch(/^[a-f0-9]{64}$/)
    expect(dataHash(large)).toBe(dataHash(JSON.parse(JSON.stringify(large))))
  })
  it('continues to reject nonfinite and excessively deep data', () => {
    expect(() => dataHash({ value: Infinity })).toThrow('Non-finite')
    let nested: unknown = 0
    for (let index = 0; index < 40; index++) nested = [nested]
    expect(() => dataHash(nested)).toThrow('resource limit')
    expect(() => dataHash(new Array(3000000))).toThrow('resource limit')
    expect(() => dataHash(Array(600).fill('x'.repeat(65536)))).toThrow('byte limit')
  })
})
