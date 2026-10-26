import { describe, expect, it } from 'vitest'
import { comfortStatusSchema } from '@/src/comfort/contract'
import { resolveDemoCall } from '../handlers'

describe('personal comfort in the demo', () => {
  it.each(['left', 'right'])('reports no learning, observations or hardware for %s', async (side) => {
    const status = comfortStatusSchema.parse(await resolveDemoCall('comfort.get', { side }))
    expect(status).toMatchObject({
      side, state: null, evaluatedAt: null, decision: null, history: [], runtime: 'stopped',
      activation: { available: false },
    })
    expect(status.fault).toContain('requires a live, authenticated Pod')
  })

  it.each([
    ['comfort.configure', { side: 'left', config: { mode: 'preview', minimumF: 70, maximumF: 95 } }],
    ['comfort.mode', { side: 'left', mode: 'preview' }],
    ['comfort.feedback', { side: 'left', feedback: { date: '2026-10-25', comfort: 'warm' } }],
  ] as const)('rejects %s without claiming a successful save', async (route, input) => {
    await expect(resolveDemoCall(route, input)).rejects.toThrow('requires a live, authenticated Pod')
    const status = comfortStatusSchema.parse(await resolveDemoCall('comfort.get', { side: 'left' }))
    expect(status.history).toEqual([])
    expect(status.state).toBeNull()
  })
})
