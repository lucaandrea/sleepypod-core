import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ValidatedProfileActivation } from '../ValidatedProfileActivation'
const mock = vi.hoisted(() => ({ apply: vi.fn(), invalidate: vi.fn(), review: vi.fn(), overview: vi.fn(), status: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { getProfileOverview: { invalidate: mock.invalidate }, listActivationHistory: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    getProfileOverview: { useQuery: mock.overview }, reviewValidatedActivation: { useQuery: mock.review },
    activateValidatedProfile: { useMutation: () => ({ mutateAsync: mock.apply, isPending: false }) },
    getActivationStatus: { useQuery: mock.status },
  },
} }))
const selection = { side: 'left' as const, revisionId: 'revision', evaluationId: 'evaluation', expectedReportHash: 'a'.repeat(64), expectedResolvedHash: 'b'.repeat(64) }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><ValidatedProfileActivation selection={selection} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.overview.mockReturnValue({ data: { desired: { binding: { generation: 4 } } } })
  mock.review.mockReturnValue({ data: { eligible: true } })
  mock.apply.mockResolvedValue({ id: 'event' })
  mock.status.mockReturnValue({ data: { observedState: 'pending_boundary', isCurrent: true } })
})
it('requires a successful current eligibility review before any application', () => {
  mock.review.mockReturnValue({ error: { message: 'Policy is not qualified' } })
  render(view())
  expect(screen.getByText('Policy is not qualified')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Apply evaluated revision' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mock.apply).not.toHaveBeenCalled()
  expect(mock.review).toHaveBeenCalledWith({ ...selection, expectedGeneration: 4 }, { enabled: true, retry: false })
})
it('pins exact evaluation and binding identity and waits for actual adoption', async () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Apply evaluated revision' }))
  await screen.findByText('Waiting for a processing boundary')
  expect(mock.apply).toHaveBeenCalledWith({ ...selection, expectedGeneration: 4, boundary: 'next_session', requester: 'web-calibration', idempotencyKey: expect.any(String) })
  expect(mock.apply.mock.calls[0][0]).not.toHaveProperty('allowUnvalidated')
  expect(screen.queryByText('Applied')).toBeNull()
})
it('retries an uncertain response unchanged even after review or binding becomes unavailable', async () => {
  mock.apply.mockRejectedValueOnce(new Error('Connection lost'))
  const rendered = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Apply evaluated revision' }))
  await waitFor(() => expect(mock.apply).toHaveBeenCalledTimes(1))
  mock.overview.mockReturnValue({ error: { message: 'Offline' } })
  mock.review.mockReturnValue({ error: { message: 'Report released' } })
  rendered.rerender(view())
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact activation request' }))
  await screen.findByText('Waiting for a processing boundary')
  expect(mock.apply.mock.calls[1][0]).toEqual(mock.apply.mock.calls[0][0])
})
it('does not apply cached eligibility while a refresh is in progress', () => {
  mock.review.mockReturnValue({ data: { eligible: true }, isFetching: true })
  render(view())
  expect((screen.getByRole('button', { name: 'Apply evaluated revision' }) as HTMLButtonElement).disabled).toBe(true)
})
