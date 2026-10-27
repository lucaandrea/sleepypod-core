import { expect, it } from 'vitest'
import { bedroomReadingCurrent } from '../presentation'

it('uses the server lease duration even if the phone clock differs, and expires disconnected data', () => {
  const generatedAt = 1793067000000
  const receivedAt = generatedAt - 30000
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 5000, receivedAt)).toBe(true)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 5000, receivedAt + 5000)).toBe(false)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 120000, receivedAt + 15000)).toBe(false)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 120000, receivedAt, true)).toBe(false)
  expect(bedroomReadingCurrent(generatedAt, receivedAt, generatedAt + 120000, receivedAt - 1)).toBe(false)
})
