import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ShadowRuns, ShadowRunDetails } from '../ShadowRuns'
import { ShadowReport } from '../ShadowReport'
vi.mock('../ShadowSchedule', () => ({ ShadowSchedule: () => <p>Scheduling controls</p> }))
const mock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), report: vi.fn(), stop: vi.fn(), setData: vi.fn(), invalidate: vi.fn(), invalidateReport: vi.fn(), refresh: vi.fn(), error: null as Error | null }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricShadow: { get: { setData: mock.setData }, list: { invalidate: mock.invalidate }, report: { invalidate: mock.invalidateReport } } }),
  biometricShadow: { list: { useQuery: mock.list }, get: { useQuery: mock.get }, report: { useQuery: mock.report },
    stop: { useMutation: () => ({ mutateAsync: mock.stop, isPending: false, error: mock.error }) } },
} }))
const run = { id: 'run', subjectId: 'Sleeper', state: 'running', pointCount: 3, startMs: 1700000000000, endMs: 1700000600000,
  candidateIdentitySaved: true, candidateConfigHash: 'candidate', activeConfigHash: 'active', planHash: 'plan' }
const i18n = setupI18n({ locale: 'en', messages: {} })
const wrap = (child: React.ReactNode) => <I18nProvider i18n={i18n}>{child}</I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.error = null
  mock.list.mockReturnValue({ data: { items: [run], nextCursor: 'next' } })
  mock.get.mockReturnValue({ data: run })
  mock.stop.mockResolvedValue({ run: { ...run, state: 'stopped' }, localAttemptSettled: false })
  mock.report.mockReturnValue({ data: { health: 'issues_detected', observedSamples: 3, expectedSlots: 10, maximumGapMs: 4000,
    issues: ['coverage_degraded', 'worker_cleanup_unconfirmed'], metrics: [{ metric: 'heart_rate', current: { coverage: 0.8 }, candidate: { coverage: null } }],
    workerReceipt: null, reportHash: 'report-hash', snapshotHash: 'snapshot-hash' }, refetch: mock.refresh, isFetching: false })
})
it('loads reports only on request and clears details on pagination', () => {
  render(wrap(<ShadowRuns side="left" />))
  expect(mock.report).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect observation' }))
  expect(screen.getByText('Saved observations: 3')).toBeTruthy()
  expect(mock.report).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review observation report' }))
  expect(mock.report).toHaveBeenCalledWith({ id: 'run' }, { staleTime: Infinity, refetchOnWindowFocus: false, retry: false })
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(mock.list).toHaveBeenLastCalledWith({ side: 'left', maximumRuns: 20, afterId: 'next' }, { refetchInterval: 5000 })
  expect(screen.queryByRole('region', { name: 'Observation details' })).toBeNull()
})
it('uses the authoritative stop response and stops terminal polling', async () => {
  const rendered = render(wrap(<ShadowRunDetails id="run" />))
  fireEvent.click(screen.getByRole('button', { name: 'Stop observation' }))
  await waitFor(() => expect(mock.setData).toHaveBeenCalledWith({ id: 'run' }, { ...run, state: 'stopped' }))
  expect(mock.stop).toHaveBeenCalledWith({ id: 'run' })
  mock.get.mockReturnValue({ data: { ...run, state: 'stopped' } })
  rendered.rerender(wrap(<ShadowRunDetails id="run" />))
  expect(screen.getByRole('status').textContent).toBe('Stop recorded')
  expect(screen.queryByRole('button', { name: 'Stop observation' })).toBeNull()
  expect(screen.getByText(/Saved observations are preserved/)).toBeTruthy()
  const options = mock.get.mock.calls[0][1]
  expect(options.refetchInterval({ state: { data: { state: 'completed' } } })).toBe(false)
  expect(options.refetchInterval({ state: { data: { state: 'running' } } })).toBe(5000)
})
it('shows absent coverage and resource evidence without inventing zeros or success', () => {
  render(wrap(<ShadowReport id="run" />))
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(screen.getByText('80%')).toBeTruthy()
  expect(screen.getByText('Worker cleanup has not been confirmed.')).toBeTruthy()
  expect(screen.getByText('No completed worker resource receipt is available.')).toBeTruthy()
  expect(screen.getByText(/not validated improvement/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }))
  expect(mock.refresh).toHaveBeenCalledOnce()
})
it('renders empty lists, load failures and mutation errors visibly', () => {
  mock.list.mockReturnValue({ data: { items: [], nextCursor: null } })
  const rendered = render(wrap(<ShadowRuns side="right" />))
  expect(screen.getByText('No prospective runs for this side.')).toBeTruthy()
  mock.list.mockReturnValue({ error: new Error('Listing unavailable') })
  rendered.rerender(wrap(<ShadowRuns side="right" />))
  expect(screen.getByText('Listing unavailable')).toBeTruthy()
  mock.error = new Error('Stop unavailable')
  rendered.rerender(wrap(<ShadowRunDetails id="run" />))
  expect(screen.getByText('Stop unavailable')).toBeTruthy()
})
it('lets a failed report be retried explicitly', () => {
  mock.report.mockReturnValue({ error: new Error('Report unavailable'), refetch: mock.refresh, isFetching: false })
  render(wrap(<ShadowReport id="run" />))
  expect(screen.getByText('Report unavailable')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry report' }))
  expect(mock.refresh).toHaveBeenCalledOnce()
})

it('labels partial resources and does not turn missing RSS into a zero measurement', () => {
  const result = mock.report()
  result.data.workerReceipt = { schema: 'biometric-shadow-partial-receipt-v1', receipt: { peakObservedRssBytes: null } }
  mock.report.mockReturnValue(result)
  render(wrap(<ShadowReport id="run" />))
  expect(screen.getByText(/Resource observations are partial/)).toBeTruthy()
  expect(screen.queryByText(/Sampled worker memory peak:/)).toBeNull()
  expect(screen.getByText(/No worker memory observation is available/)).toBeTruthy()
})
