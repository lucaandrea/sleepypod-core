import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ProfileComparison } from '../ProfileComparison'
vi.mock('../ManualProfileActivation', () => ({ ManualProfileActivation: () => <p>Activation controls</p> }))
const mock = vi.hoisted(() => ({ compare: vi.fn(), generation: 2, hash: 'before-hash', diff: undefined as unknown }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricTuning: {
  getProfileOverview: { useQuery: () => ({ data: { desired: { hash: mock.hash, warning: null, binding: { generation: mock.generation, desiredRevisionId: 'saved-id' } } } }) },
  diffProfileRevision: { useMutation: () => ({ mutateAsync: mock.compare, data: mock.diff, isPending: false }) },
} } }))
const result = { revisionId: 'candidate-id', beforeHash: 'before-hash', afterHash: 'after-hash', changes: [{ path: 'heart_rate.trackingToleranceBpm', before: 15, after: 18 }], intentChangedPaths: ['hrv_index.minimumWindows'] }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><ProfileComparison side="right" revisionId="candidate-id" /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.generation = 2
  mock.hash = 'before-hash'
  mock.diff = undefined
  mock.compare.mockImplementation(async () => {
    mock.diff = result
  })
})
it('compares exact revision IDs and separates resolved values from override intent', async () => {
  render(view())
  expect(mock.compare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Compare with saved profile' }))
  await screen.findByText('after-hash')
  expect(mock.compare).toHaveBeenCalledWith({ side: 'right', revisionId: 'candidate-id', againstRevisionId: 'saved-id' })
  expect(screen.getByText('15')).toBeTruthy()
  expect(screen.getByText('18')).toBeTruthy()
  expect(screen.getByText('hrv_index.minimumWindows')).toBeTruthy()
  expect(screen.getByText(/not validation evidence/)).toBeTruthy()
})
it('hides obsolete results when the saved generation changes even with the same hash', async () => {
  const rendered = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Compare with saved profile' }))
  await screen.findByText('after-hash')
  mock.generation = 3
  rendered.rerender(view())
  expect(screen.getByText(/The saved profile changed/)).toBeTruthy()
  expect(screen.queryByText('after-hash')).toBeNull()
})
it('retains intent-only changes without inventing numerical differences', async () => {
  mock.compare.mockImplementation(async () => {
    mock.diff = { ...result, afterHash: 'before-hash', changes: [] }
  })
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Compare with saved profile' }))
  await screen.findByText('No resolved value changes.')
  expect(screen.getByText('hrv_index.minimumWindows')).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

it('requires a new recovery selection if the binding changed before comparison', () => {
  render(<I18nProvider i18n={i18n}><ProfileComparison side="right" revisionId={null} action="reset" selectionGeneration={1} /></I18nProvider>)
  expect(screen.getByText('The saved profile changed. Select a recovery action again to make a new request.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Compare with saved profile' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mock.compare).not.toHaveBeenCalled()
})
