import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { WaveformDatasetBuilder } from '../WaveformDatasetBuilder'
const mock = vi.hoisted(() => ({ scan: vi.fn(), publish: vi.fn(), page: vi.fn(), refetch: vi.fn(), invalidate: vi.fn(), admitted: true }))
vi.mock('../ExperimentBuilder', () => ({ ExperimentBuilder: ({ datasetId }: { datasetId: string }) => <p>{`Protocol for ${datasetId}`}</p> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listRawSources: { invalidate: mock.invalidate }, listDatasets: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    getReplayAdmission: { useQuery: () => ({ data: { admitted: mock.admitted, reasons: mock.admitted ? [] : ['unqualified'] }, refetch: mock.refetch }) },
    listRawSources: { useQuery: mock.page },
    inspectRawSource: { useMutation: () => ({ mutateAsync: mock.scan, isPending: false }) },
    createWaveformDataset: { useMutation: () => ({ mutateAsync: mock.publish, isPending: false }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const cohorts = [{ cohortId: 'one', startMs: 600000, endMs: 900000, nightLabels: ['Night one'] },
  { cohortId: 'two', startMs: 1800000, endMs: 2100000, nightLabels: ['Night two'] }]
const source = (id: string) => ({ id, inspection: { source_name: `${id}.RAW.gz`, artifact: { compressed_bytes: 100 }, inventory: { ordered_waveform_available: true } } })
const view = () => render(<I18nProvider i18n={i18n}><WaveformDatasetBuilder parentId="parent" parentHash="exact-hash" cohorts={cohorts} /></I18nProvider>)
beforeEach(() => {
  vi.clearAllMocks()
  mock.admitted = true
  mock.page.mockImplementation(({ startMs, afterId }) => ({ data: { items: [source(startMs === 300000 ? afterId ? 'b' : 'a' : 'c')], nextCursor: afterId ? null : 'next' } }))
  mock.publish.mockResolvedValue({ status: 'published', dataset: { id: 'waveform-id', available: true } })
})
it('preserves selections across pages and nights and pins the parent hash on publication', async () => {
  view()
  expect(mock.page).toHaveBeenCalledWith({ startMs: 300000, endMs: 900000, afterId: undefined }, { enabled: true })
  expect((screen.getByRole('button', { name: 'Retain selected waveforms' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Next archive page' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('Frozen night'), { target: { value: 'two' } })
  expect(mock.page).toHaveBeenLastCalledWith({ startMs: 1500000, endMs: 2100000, afterId: undefined }, { enabled: true })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Retain selected waveforms' }))
  await screen.findByText('Protocol for waveform-id')
  expect(mock.publish).toHaveBeenCalledWith({ parentDatasetId: 'parent', expectedContentHash: 'exact-hash',
    cohorts: [{ cohortId: 'one', sourceIds: ['a', 'b'] }, { cohortId: 'two', sourceIds: ['c'] }], idempotencyKey: expect.any(String) })
})
it('retries an uncertain publication with the identical request and does not claim deferred or released bytes', async () => {
  view()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('Frozen night'), { target: { value: 'two' } })
  fireEvent.click(screen.getByRole('checkbox'))
  mock.publish.mockRejectedValueOnce(new Error('Lost reply')).mockResolvedValueOnce({ status: 'deferred' })
    .mockResolvedValueOnce({ status: 'published', dataset: { id: 'released', available: false } })
  const button = screen.getByRole('button', { name: 'Retain selected waveforms' })
  fireEvent.click(button)
  await waitFor(() => expect(mock.publish).toHaveBeenCalledTimes(1))
  fireEvent.click(button)
  await waitFor(() => expect(mock.publish).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(/Waveform dataset retained:/)).toBeNull()
  expect(mock.publish.mock.calls[0][0]).toEqual(mock.publish.mock.calls[1][0])
  fireEvent.click(button)
  await screen.findByText(/This request refers to a released dataset/)
  expect(screen.queryByText(/Protocol for/)).toBeNull()
})
it('preserves a deferred scan cursor, advances unavailable sources, and stops at completion', async () => {
  mock.scan.mockResolvedValueOnce({ status: 'deferred', nextCursor: null })
    .mockResolvedValueOnce({ status: 'source_unavailable', nextCursor: 'a.RAW.gz' })
    .mockResolvedValueOnce({ status: 'complete', nextCursor: null })
  view()
  const button = screen.getByRole('button', { name: 'Inspect next archive' })
  fireEvent.click(button)
  await waitFor(() => expect(mock.refetch).toHaveBeenCalledTimes(1))
  fireEvent.click(button)
  await waitFor(() => expect(mock.refetch).toHaveBeenCalledTimes(2))
  expect(mock.scan.mock.calls[0][0]).toEqual(mock.scan.mock.calls[1][0])
  fireEvent.click(button)
  await screen.findByText('Archive scan complete.')
  expect(mock.scan).toHaveBeenLastCalledWith({ afterName: 'a.RAW.gz' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
})
it('does not allow new scans without admission', () => {
  mock.admitted = false
  view()
  expect((screen.getByRole('button', { name: 'Inspect next archive' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/New archive work is currently deferred/)).toBeTruthy()
})
