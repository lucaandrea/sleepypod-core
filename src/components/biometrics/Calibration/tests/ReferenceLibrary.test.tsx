import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ReferenceLibrary } from '../ReferenceLibrary'
const mock = vi.hoisted(() => ({ remove: vi.fn(), invalidate: vi.fn(), imports: vi.fn(), records: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } },
  useUtils: () => ({ biometricTuning: { listImports: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    listImports: { useQuery: mock.imports }, getImportMeasurements: { useQuery: mock.records },
    deleteImport: { useMutation: () => ({ mutateAsync: mock.remove, isPending: false }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const item = { id: 'import-id', revision: 1, available: true, summary: { source: 'watch', subjectId: 'sleeper', accepted: 1, unscorable: 0 } }
beforeEach(() => {
  vi.clearAllMocks()
  mock.imports.mockReturnValue({ data: { items: [item], nextCursor: { createdAtMs: 123, id: 'cursor-id' } } })
  mock.records.mockReturnValue({ data: { items: [{ id: 7, metric: 'heart_rate', value: 60, stage: null, unit: 'bpm', startMs: 1791673200000, endMs: 1791673200000, exclusions: [] }], nextCursor: 7 } })
  mock.remove.mockResolvedValue({ id: item.id })
})
const view = () => render(<I18nProvider i18n={i18n}><ReferenceLibrary side="left" /></I18nProvider>)
it('pages imports and exact normalized measurements without interpolation', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect measurements' }))
  expect(screen.getByText('60 bpm')).toBeTruthy()
  expect(screen.getAllByText(new Date(1791673200000).toISOString())).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }))
  expect(mock.records).toHaveBeenLastCalledWith({ id: item.id, afterId: 7, limit: 100 })
  fireEvent.click(screen.getByRole('button', { name: 'Older imports' }))
  expect(mock.imports).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 123, beforeId: 'cursor-id' })
})
it('requires explicit deletion and refreshes the retained library afterward', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  expect(mock.remove).not.toHaveBeenCalled()
  expect(screen.getByText(/Retained dataset copies must be released separately/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Keep import' }))
  expect(screen.queryByRole('button', { name: 'Permanently delete import' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently delete import' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledOnce())
  expect(mock.remove).toHaveBeenCalledWith({ id: item.id })
})
it('keeps deleted metadata visible without offering nonexistent measurements', () => {
  mock.imports.mockReturnValue({ data: { items: [{ ...item, available: false }], nextCursor: null } })
  view()
  expect(screen.getByText('Source measurements deleted')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Inspect measurements' })).toBeNull()
})
