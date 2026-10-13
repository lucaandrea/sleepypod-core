// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { withBiometricBackgroundSlot } from '../background-admission'
const shared = globalThis as typeof globalThis & { __biometricBackgroundSlotsV1?: unknown }
afterEach(() => {
  delete shared.__biometricBackgroundSlotsV1
})
it('reserves work synchronously while leaving one report read available', async () => {
  let finish!: () => void
  const work = withBiometricBackgroundSlot('work', () => new Promise<void>((resolve) => {
    finish = resolve
  }))
  const other = vi.fn(async () => null)
  await expect(withBiometricBackgroundSlot('work', other)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  expect(other).not.toHaveBeenCalled()
  expect(await withBiometricBackgroundSlot('read', async () => 'report')).toBe('report')
  finish()
  await work
  expect(await withBiometricBackgroundSlot('work', other)).toBeNull()
})
it('shares ownership across module reloads and releases ordinary failures', async () => {
  let finish!: () => void
  const work = withBiometricBackgroundSlot('work', () => new Promise<void>((resolve) => {
    finish = resolve
  }))
  vi.resetModules()
  const copy = await import('../background-admission')
  await expect(copy.withBiometricBackgroundSlot('work', async () => null)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  finish()
  await work
  await expect(copy.withBiometricBackgroundSlot('work', async () => {
    throw new Error('failed')
  })).rejects.toThrow('failed')
  expect(() => withBiometricBackgroundSlot('work', () => {
    throw new Error('synchronous')
  })).toThrow('synchronous')
  expect(await withBiometricBackgroundSlot('work', async () => 'available')).toBe('available')
})
it.each(['SHADOW_CLEANUP_UNCONFIRMED', 'BIOMETRIC_COORDINATOR_CLEANUP_UNCONFIRMED'])('quarantines uncertain cleanup: %s', async (code) => {
  await expect(withBiometricBackgroundSlot('work', async () => {
    throw Object.assign(new Error('cleanup'), { code })
  })).rejects.toMatchObject({ code })
  await expect(withBiometricBackgroundSlot('work', async () => null)).rejects.toThrow('cleanup is unconfirmed')
  expect(await withBiometricBackgroundSlot('read', async () => 'diagnostics')).toBe('diagnostics')
})
