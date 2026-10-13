import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BiometricCalibration } from '../BiometricCalibration'
const mock = vi.hoisted(() => ({ overview: undefined as unknown, overviewError: null as Error | null, activation: undefined as unknown,
  history: { items: [] as unknown[], nextGeneration: null as number | null }, historyQuery: vi.fn(), sideChange: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  biometricTuning: {
    getProfileOverview: { useQuery: () => ({ data: mock.overview, error: mock.overviewError }) },
    getActivationStatus: { useQuery: () => ({ data: mock.activation }) },
    listActivationHistory: { useQuery: (input: unknown) => {
      mock.historyQuery(input)
      return { data: mock.history }
    } },
  },
  settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } },
} }))
vi.mock('../ProfileRecovery', () => ({ ProfileRecovery: () => <p>Recovery controls</p> }))
vi.mock('../ShadowRuns', () => ({ ShadowRuns: ({ side }: { side: string }) => <p>{`Prospective runs ${side}`}</p> }))
vi.mock('../ProfileLibrary', () => ({ ProfileLibrary: () => <p>Candidate editor</p> }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right' }) }))
vi.mock('@/src/components/Settings/SleepStageRules', () => ({ SleepStageRules: ({ side }: { side: string }) => <p>{`Existing stage editor ${side}`}</p> }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = (side: 'left' | 'right' = 'left') => <I18nProvider i18n={i18n}><BiometricCalibration side={side} onSideChange={mock.sideChange} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.overviewError = null
  mock.overview = { desired: { isDefault: false, hash: 'exact-config', binding: { generation: 2 }, warning: 'Using compatible fallback' },
    runtimeHealth: { state: 'stale', components: [{ component: 'heart_rate', state: 'stale' }] },
    stageView: { provenance: { warning: null } }, sensorCalibration: [], limitations: [] }
  mock.activation = { observedState: 'pending_boundary' }
  mock.history = { items: [], nextGeneration: null }
})
it('distinguishes saved personalization, pending adoption and stale health', () => {
  render(view())
  expect(screen.getByText('Personalized profile')).toBeTruthy()
  expect(screen.getByText('Waiting for a processing boundary')).toBeTruthy()
  expect(screen.getAllByText('Stale')).toHaveLength(2)
  expect(screen.queryByText('Applied')).toBeNull()
  expect(screen.getByText('Using compatible fallback')).toBeTruthy()
  expect(screen.getByText('No sensor calibration has been reported for this side.')).toBeTruthy()
  expect(screen.getByText(/not clinical beat-to-beat RMSSD/)).toBeTruthy()
})
it('reuses the existing stage editor and keeps manual activation semantics visible', () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }))
  expect(screen.getByText('Existing stage editor left')).toBeTruthy()
  expect(screen.getByText(/unvalidated manual settings/)).toBeTruthy()
})
it('opens prospective observations for the selected side', () => {
  const rendered = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Observations' }))
  expect(screen.getByText('Prospective runs left')).toBeTruthy()
  rendered.rerender(view('right'))
  expect(screen.getByText('Prospective runs right')).toBeTruthy()
})
it('resets history pagination on side changes and labels historical acknowledgements', () => {
  mock.history = { items: [{ id: 'event', generation: 4, action: 'rollback', state: 'applied', createdAtMs: 1791673200000,
    previousHash: 'before', nextHash: 'after', requester: 'fixture', reason: null }], nextGeneration: 4 }
  const result = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(screen.getByText(/Past acknowledgements/)).toBeTruthy()
  expect(screen.getByText('Restore previous profile')).toBeTruthy()
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Older changes' }))
  expect(mock.historyQuery).toHaveBeenLastCalledWith({ side: 'left', beforeGeneration: 4 })
  result.rerender(view('right'))
  expect(mock.historyQuery).toHaveBeenLastCalledWith({ side: 'right', beforeGeneration: undefined })
})
it('shows loading or errors without substituting healthy state', () => {
  mock.overview = undefined
  const result = render(view())
  expect(screen.queryByText('Applied')).toBeNull()
  mock.overviewError = new Error('Processor data unavailable')
  result.rerender(view())
  expect(screen.getByText('Processor data unavailable')).toBeTruthy()
})
