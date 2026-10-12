import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BacktestJobs, BacktestJobDetails } from '../BacktestJobs'
const mock = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), cancel: vi.fn(), setData: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { getBacktest: { setData: mock.setData }, listBacktests: { invalidate: mock.invalidate } } }),
  biometricTuning: { getBacktest: { useQuery: mock.get }, listBacktests: { useQuery: mock.list }, cancelBacktest: { useMutation: () => ({ mutateAsync: mock.cancel, isPending: false }) } },
} }))
const job = { id: 'job-id', state: 'queued', attempt: 0, split: 'tuning', evaluationScope: 'stage_rules_on_original_readings', progress: { phase: 'queued', completedNights: 0, totalNights: 0 }, error: null, datasetId: 'dataset-id', datasetHash: 'dataset-hash', evaluatorBuildHash: 'worker-hash', configurations: [{ label: 'candidate', revisionId: 'candidate-id', hash: 'candidate-hash' }] }
const i18n = setupI18n({ locale: 'en', messages: {} })
const details = () => <I18nProvider i18n={i18n}><BacktestJobDetails id={job.id} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.get.mockReturnValue({ data: job })
  mock.list.mockReturnValue({ data: { items: [job], nextCursor: { createdAtMs: 100, id: job.id } } })
  mock.cancel.mockResolvedValue({ ...job, state: 'cancel_requested' })
})
it('shows queued work without invented progress and pages job history', () => {
  render(<I18nProvider i18n={i18n}><BacktestJobs side="left" /></I18nProvider>)
  expect(mock.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect job' }))
  expect(screen.getByText(/Waiting for a worker and resource admission/)).toBeTruthy()
  expect(screen.getByText('Night progress is not available yet.')).toBeTruthy()
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Older jobs' }))
  expect(mock.list).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 100, beforeId: job.id }, { refetchInterval: 5000 })
})
it('uses the authoritative cancellation response without prematurely claiming cancelled', async () => {
  const rendered = render(details())
  fireEvent.click(screen.getByRole('button', { name: 'Cancel backtest' }))
  await waitFor(() => expect(mock.setData).toHaveBeenCalledWith({ id: job.id }, { ...job, state: 'cancel_requested' }))
  expect(mock.cancel).toHaveBeenCalledWith({ id: job.id })
  mock.get.mockReturnValue({ data: { ...job, state: 'cancel_requested' } })
  rendered.rerender(details())
  expect(screen.getByText('Cancellation requested')).toBeTruthy()
  expect(screen.queryByText('Cancelled')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel backtest' })).toBeNull()
})
it('stops detail polling after terminal execution and keeps success separate from improvement', () => {
  mock.get.mockReturnValue({ data: { ...job, state: 'succeeded', progress: { phase: 'complete', completedNights: 3, totalNights: 3 } } })
  render(details())
  expect(screen.getByText(/Review the report before drawing conclusions/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Cancel backtest' })).toBeNull()
  const options = mock.get.mock.calls[0][1]
  expect(options.refetchInterval({ state: { data: { state: 'succeeded' } } })).toBe(false)
  expect(options.refetchInterval({ state: { data: { state: 'interrupted' } } })).toBe(5000)
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('3')
})
