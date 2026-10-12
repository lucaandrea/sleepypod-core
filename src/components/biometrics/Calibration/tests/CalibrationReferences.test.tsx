import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CalibrationReferences } from '../CalibrationReferences'

const mock = vi.hoisted(() => ({ preview: vi.fn(), commit: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } }, useUtils: () => ({ biometricTuning: { listImports: { invalidate: vi.fn() } } }), biometricTuning: {
  previewImport: { useMutation: () => ({ mutateAsync: mock.preview, isPending: false }) },
  commitImport: { useMutation: () => ({ mutateAsync: mock.commit, isPending: false }) },
} } }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const summary = { contentHash: 'a'.repeat(64), accepted: 1, rejected: 1, duplicates: 0, unscorable: 0, conflicts: 0,
  metrics: ['heart_rate'], warnings: ['Sparse coverage'], rejectionExamples: [{ row: 2, message: 'Invalid unit' }] }
beforeEach(() => {
  vi.clearAllMocks()
  mock.preview.mockResolvedValue(summary)
  mock.commit.mockResolvedValue({ id: 'saved-id' })
})
function setup() {
  render(<I18nProvider i18n={i18n}><CalibrationReferences side="right" /></I18nProvider>)
  fireEvent.change(screen.getByLabelText('Sleeper identifier'), { target: { value: 'sleeper' } })
  fireEvent.change(screen.getByLabelText('Reference source'), { target: { value: 'watch' } })
  fireEvent.change(screen.getByLabelText('Reference records'), { target: { value: 'recordKey,metric,value,unit,timestamp\n1,heart_rate,60,bpm,2026-10-10T23:00:00Z' } })
}
it('previews parsed records and requires deliberate acceptance of rejected rows before exact-hash commit', async () => {
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }))
  await screen.findByText('Sparse coverage')
  expect(mock.commit).not.toHaveBeenCalled()
  const save = screen.getByRole('button', { name: 'Save previewed import' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(save)
  await screen.findByText('Reference import saved: saved-id')
  expect(mock.commit).toHaveBeenCalledWith({ import: { side: 'right', subjectId: 'sleeper', source: 'watch', rows: [
    { recordKey: '1', metric: 'heart_rate', value: 60, unit: 'bpm', timestamp: '2026-10-10T23:00:00Z' },
  ] }, previewHash: summary.contentHash, acceptRejectedRows: true })
})
it('invalidates a reviewed payload when metadata changes', async () => {
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }))
  await screen.findByText('Sparse coverage')
  fireEvent.change(screen.getByLabelText('Reference source'), { target: { value: 'different watch' } })
  expect(screen.queryByRole('button', { name: 'Save previewed import' })).toBeNull()
  expect(mock.commit).not.toHaveBeenCalled()
})
it('rejects malformed files locally and surfaces commit failures without claiming success', async () => {
  setup()
  fireEvent.change(screen.getByLabelText('Reference records'), { target: { value: 'invalid,header\n1,2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }))
  await screen.findByText('CSV headers must be unique documented field names')
  expect(mock.preview).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Data format'), { target: { value: 'json' } })
  fireEvent.change(screen.getByLabelText('Reference records'), { target: { value: '[{}]' } })
  mock.commit.mockRejectedValue(new Error('Preview hash mismatch'))
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }))
  await screen.findByText('Sparse coverage')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Save previewed import' }))
  await waitFor(() => expect(screen.getByText('Preview hash mismatch')).toBeTruthy())
  expect(screen.queryByText(/Reference import saved:/)).toBeNull()
})

it('pins corrections to the selected parent while preserving mapping and stale-revision errors', async () => {
  render(<I18nProvider i18n={i18n}><CalibrationReferences side="left" correction={{ id: 'parent-id', subjectId: 'original-sleeper', source: 'original-watch' }} /></I18nProvider>)
  expect((screen.getByLabelText('Sleeper identifier') as HTMLInputElement).readOnly).toBe(true)
  expect((screen.getByLabelText('Reference source') as HTMLInputElement).readOnly).toBe(true)
  fireEvent.change(screen.getByLabelText('Data format'), { target: { value: 'json' } })
  fireEvent.change(screen.getByLabelText('Reference records'), { target: { value: '[{}]' } })
  mock.preview.mockResolvedValue({ ...summary, rejected: 0, startMs: 1791673200000, endMs: 1791673260000 })
  mock.commit.mockRejectedValue(new Error('Another correction exists; use the latest import revision'))
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }))
  await screen.findByText(/This is the first-to-last record span/)
  fireEvent.click(screen.getByRole('button', { name: 'Save previewed import' }))
  await screen.findByText('Another correction exists; use the latest import revision')
  expect(mock.commit).toHaveBeenCalledWith({ import: { side: 'left', subjectId: 'original-sleeper', source: 'original-watch', rows: [{}] }, previewHash: summary.contentHash, acceptRejectedRows: false, supersedesImportId: 'parent-id' })
  expect(screen.queryByText(/Reference import saved:/)).toBeNull()
})
