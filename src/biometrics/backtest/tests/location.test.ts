// @vitest-environment node
import { resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { packagedWorkerPath, packagedCoordinatorPath, packagedShadowHostPath } from '../location'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
beforeEach(() => vi.mocked(existsSync).mockReset())

it.each([
  ['worker', packagedWorkerPath],
  ['coordinator', packagedCoordinatorPath],
  ['shadow-host', packagedShadowHostPath],
] as const)('resolves only fixed %s packages, preferring the installed bundle', (name, locate) => {
  const installed = resolve(`biometrics-worker/${name}.cjs`)
  const development = resolve(`.next/standalone/biometrics-worker/${name}.cjs`)
  vi.mocked(existsSync).mockReturnValue(true)
  expect(locate()).toBe(installed)
  expect(existsSync).toHaveBeenCalledExactlyOnceWith(installed)
  vi.mocked(existsSync).mockReset().mockImplementation(path => path === development)
  expect(locate()).toBe(development)
  expect(vi.mocked(existsSync).mock.calls).toEqual([[installed], [development]])
  vi.mocked(existsSync).mockReset().mockReturnValue(false)
  expect(locate).toThrow(expect.objectContaining({ code: 'WORKER_UNAVAILABLE' }))
})
