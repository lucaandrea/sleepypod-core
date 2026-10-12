import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DatasetLibrary } from '../DatasetLibrary'
vi.mock('../ExperimentBuilder', () => ({ ExperimentBuilder: () => <p>Protocol editor</p> }))
const mock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), release: vi.fn(), invalidateList: vi.fn(), invalidateDetail: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listDatasets: { invalidate: mock.invalidateList }, getDataset: { invalidate: mock.invalidateDetail } } }),
  biometricTuning: { listDatasets: { useQuery: mock.list }, getDataset: { useQuery: mock.get }, releaseDataset: { useMutation: () => ({ mutateAsync: mock.release, isPending: false }) } },
} }))
const item = { id: 'dataset-id', subjectId: 'sleeper', byteLength: 4096, available: true, contentHash: 'exact-hash', manifest: { coverage: [], capabilities: { signalReplay: false }, limitations: ['Raw inputs unavailable'], splitProtocol: { timezone: 'UTC', evidence: 'descriptive_only', assignments: [{ cohortId: 'night', nightLabels: ['2026-10-10'], sessionIds: [5], split: 'tuning' }], limitations: [] } } }
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.list.mockReturnValue({ data: { items: [item], nextCursor: { createdAtMs: 100, id: item.id } } })
  mock.get.mockReturnValue({ data: item })
  mock.release.mockResolvedValue({ ...item, available: false })
})
const view = () => render(<I18nProvider i18n={i18n}><DatasetLibrary side="right" /></I18nProvider>)
it('inspects the integrity-checked descriptor on demand and uses the full page cursor', () => {
  view()
  expect(mock.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect dataset' }))
  expect(mock.get).toHaveBeenCalledWith({ id: item.id })
  expect(screen.getByText('exact-hash')).toBeTruthy()
  expect(screen.getByText('Descriptive evaluation only')).toBeTruthy()
  expect(screen.getByText('Raw inputs unavailable')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Older datasets' }))
  expect(mock.list).toHaveBeenLastCalledWith({ side: 'right', beforeCreatedAtMs: 100, beforeId: item.id })
})
it('requires deliberate release and refreshes both list and exact descriptor', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect dataset' }))
  fireEvent.click(screen.getByRole('button', { name: 'Release retained inputs' }))
  expect(mock.release).not.toHaveBeenCalled()
  expect(screen.getByText(/Active jobs must finish or be cancelled first/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Keep retained inputs' }))
  expect(screen.queryByRole('button', { name: 'Permanently release inputs' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Release retained inputs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently release inputs' }))
  await waitFor(() => expect(mock.invalidateDetail).toHaveBeenCalledWith({ id: item.id }))
  expect(mock.release).toHaveBeenCalledWith({ id: item.id })
  expect(mock.invalidateList).toHaveBeenCalledOnce()
})
it('keeps released metadata inspectable without claiming input availability', () => {
  mock.list.mockReturnValue({ data: { items: [{ ...item, available: false }], nextCursor: null } })
  mock.get.mockReturnValue({ data: { ...item, available: false } })
  view()
  expect(screen.getByText(/Inputs released; metadata retained/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect dataset' }))
  expect(screen.getByText('The retained inputs are unavailable for new evaluations.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Release retained inputs' })).toBeNull()
})
