import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BacktestSubmission } from '../BacktestSubmission'
vi.mock('../BacktestJobs', () => ({ BacktestJobDetails: () => <p>Job status</p> }))
const mock = vi.hoisted(() => ({ enqueue: vi.fn(), invalidate: vi.fn(), generation: 2, available: true, data: undefined as unknown }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listBacktests: { invalidate: mock.invalidate }, listExperiments: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    listProfileRevisions: { useQuery: () => ({ data: { items: [{ id: 'candidate-id', revision: 1, resolvedHash: 'candidate-hash' }], nextCursor: null } }) },
    getProfileOverview: { useQuery: () => ({ data: { desired: { binding: { generation: mock.generation } } } }) },
    getDataset: { useQuery: () => ({ data: { available: mock.available, contentHash: 'dataset-hash', manifest: { splitProtocol: { assignments: [{ split: 'tuning' }, { split: 'holdout' }] } } } }) },
    enqueueBacktest: { useMutation: () => ({ mutateAsync: mock.enqueue, data: mock.data, isPending: false }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><BacktestSubmission side="left" experimentId="experiment-id" datasetId="dataset-id" /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.generation = 2
  mock.available = true
  mock.data = undefined
  mock.enqueue.mockImplementation(async () => {
    mock.data = { id: 'job-id', evaluatorBuildHash: 'worker-hash' }
    return mock.data
  })
})
it('requires an explicit candidate and holdout acknowledgement and pins the submission generation', async () => {
  render(view())
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio'))
  fireEvent.change(screen.getByLabelText('Evaluation split'), { target: { value: 'holdout' } })
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await screen.findByText('Backtest request saved: job-id')
  expect(mock.enqueue).toHaveBeenCalledWith({ experimentId: 'experiment-id', candidateRevisionId: 'candidate-id', expectedBindingGeneration: 2, split: 'holdout', idempotencyKey: expect.any(String) })
  expect(screen.getByText(/does not mean execution has started/)).toBeTruthy()
})
it('retries the original uncertain request even if the current binding changes', async () => {
  const rendered = render(view())
  mock.enqueue.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('radio'))
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await waitFor(() => expect(mock.enqueue).toHaveBeenCalledOnce())
  mock.generation = 3
  rendered.rerender(view())
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await screen.findByText('Backtest request saved: job-id')
  expect(mock.enqueue.mock.calls[0][0]).toEqual(mock.enqueue.mock.calls[1][0])
})
it('does not offer released data or splits absent from the frozen manifest', () => {
  const rendered = render(view())
  expect((screen.getByRole('option', { name: 'Validation' }) as HTMLOptionElement).disabled).toBe(true)
  mock.available = false
  rendered.rerender(view())
  expect(screen.getByText('The retained inputs are unavailable for new evaluations.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Queue backtest' })).toBeNull()
})
