import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DatasetBuilder } from '../DatasetBuilder'
const mock = vi.hoisted(() => ({ create: vi.fn(), invalidate: vi.fn(), data: undefined as unknown }))
vi.mock('../ReplaySessionPicker', () => ({ ReplaySessionPicker: ({ onChange }: { onChange: (ids: number[]) => void }) => <button onClick={() => onChange([9, 2])}>Select nights</button> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listDatasets: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    createDataset: { useMutation: () => ({ mutateAsync: mock.create, data: mock.data, isPending: false }) },
    listImports: { useQuery: () => ({ data: { items: [
      { id: 'ref-1', familyId: 'family', revision: 1, available: true, summary: { source: 'watch', subjectId: 'sleeper' } },
      { id: 'ref-2', familyId: 'family', revision: 2, available: true, summary: { source: 'watch', subjectId: 'sleeper' } },
      { id: 'other', familyId: 'other-family', revision: 1, available: true, summary: { source: 'other watch', subjectId: 'another sleeper' } },
    ], nextCursor: null } }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.data = undefined
  mock.create.mockImplementation(async () => {
    mock.data = { id: 'dataset-id', contentHash: 'content-hash', manifest: { splitProtocol: { evidence: 'descriptive_only', assignments: [], limitations: [] }, limitations: [] } }
    return mock.data
  })
})
function setup() {
  render(<I18nProvider i18n={i18n}><DatasetBuilder side="left" /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Select nights' }))
  fireEvent.change(screen.getByLabelText('Dataset sleeper identifier'), { target: { value: 'sleeper' } })
}
it('freezes exact sessions and one reference revision with no invented validation result', async () => {
  setup()
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes[2].disabled).toBe(true)
  fireEvent.click(boxes[0])
  expect(boxes[1].disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await screen.findByText('Dataset saved: dataset-id')
  expect(mock.create).toHaveBeenCalledWith({ side: 'left', subjectId: 'sleeper', sessionIds: [2, 9], referenceImportIds: ['ref-1'], idempotencyKey: expect.any(String) })
  expect(screen.getByText(/Too few independent nights/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Freeze selected inputs' }) as HTMLButtonElement).disabled).toBe(true)
})
it('clears reference mapping when the sleeper changes', () => {
  setup()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.change(screen.getByLabelText('Dataset sleeper identifier'), { target: { value: 'another sleeper' } })
  expect(screen.getByText('Selected reference revisions: 0 / 20')).toBeTruthy()
  expect(screen.getByText(/No references selected/)).toBeTruthy()
})
it('reuses its exact request key after an uncertain response', async () => {
  setup()
  mock.create.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await screen.findByText('Dataset saved: dataset-id')
  expect(mock.create.mock.calls[0][0]).toEqual(mock.create.mock.calls[1][0])
})
