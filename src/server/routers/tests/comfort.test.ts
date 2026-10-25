import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultComfortState } from '@/src/comfort/policy'
import { ComfortInputError } from '@/src/comfort/runtime'

const runtime = vi.hoisted(() => ({ status: vi.fn(), configure: vi.fn(), feedback: vi.fn() }))
vi.mock('@/src/comfort/instance', () => ({ getComfortRuntime: () => runtime }))
const { comfortRouter } = await import('../comfort')
const caller = comfortRouter.createCaller({})

beforeEach(() => {
  vi.resetAllMocks()
  const result = {
    apiVersion: 1, generatedAt: 1, side: 'left', timezone: 'UTC', deviceDate: '2026-10-25', state: defaultComfortState(),
    history: [], evaluatedAt: null, decision: null, fault: null, runtime: 'stopped',
    activation: { available: false, reason: 'Hardware qualification and reviewed Preview nights are pending.' },
    features: { sensorAware: false, followBedtime: false },
  }
  runtime.status.mockReturnValue(result)
  runtime.configure.mockResolvedValue(result)
  runtime.feedback.mockResolvedValue(result)
})

describe('personal comfort API contract', () => {
  it('reads status without starting or evaluating the service', async () => {
    expect(await caller.get({ side: 'left' })).toMatchObject({ runtime: 'stopped', activation: { available: false } })
    expect(runtime.configure).not.toHaveBeenCalled()
  })

  it('rejects activation and unsupported adapters before touching persisted state', async () => {
    for (const config of [
      { mode: 'active' as const, minimumF: 70, maximumF: 95 },
      { mode: 'preview' as const, minimumF: 70, maximumF: 95, sensorAware: true },
      { mode: 'preview' as const, minimumF: 70, maximumF: 95, followBedtime: true },
    ]) await expect(caller.configure({ side: 'left', config })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(runtime.configure).not.toHaveBeenCalled()
  })

  it('validates bounds and returns an actionable date error without treating storage failure as input', async () => {
    await expect(caller.configure({ side: 'left', config: { mode: 'preview', minimumF: 95, maximumF: 70 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    runtime.feedback.mockRejectedValueOnce(new ComfortInputError('Future local date'))
    await expect(caller.feedback({ side: 'left', feedback: { date: '2026-10-26', comfort: 'warm' } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Future local date' })
    runtime.feedback.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(caller.feedback({ side: 'left', feedback: { date: '2026-10-25', comfort: 'warm' } })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})
