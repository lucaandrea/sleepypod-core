// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { initializeScheduler, register } from '../instrumentation'

const node = vi.hoisted(() => ({ loads: 0, register: vi.fn(), initialize: vi.fn() }))
vi.mock('../src/server/instrumentation-node', () => {
  node.loads++
  return { registerNodeInstrumentation: node.register, initializeScheduler: node.initialize }
})
afterEach(() => vi.unstubAllEnvs())

it('imports no Node lifecycle module for Edge or unknown runtimes', async () => {
  expect(node.loads).toBe(0)
  for (const runtime of ['edge', 'experimental-edge', 'workerd']) {
    vi.stubEnv('NEXT_RUNTIME', runtime)
    await register()
    await initializeScheduler()
  }
  expect(node.loads).toBe(0)
  expect(node.register).not.toHaveBeenCalled()
  expect(node.initialize).not.toHaveBeenCalled()
})

it('loads the Node lifecycle only for Node or an unset script runtime', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs')
  await register()
  await initializeScheduler()
  expect(node.loads).toBe(1)
  expect(node.register).toHaveBeenCalledOnce()
  expect(node.initialize).toHaveBeenCalledOnce()
  vi.stubEnv('NEXT_RUNTIME', undefined)
  await register()
  expect(node.register).toHaveBeenCalledTimes(2)
})
