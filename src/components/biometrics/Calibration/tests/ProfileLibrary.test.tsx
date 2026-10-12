import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ProfileLibrary } from '../ProfileLibrary'
const mock = vi.hoisted(() => ({ query: vi.fn(), editor: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricTuning: { listProfileRevisions: { useQuery: mock.query } } } }))
vi.mock('../ProfileCandidateEditor', () => ({ ProfileCandidateEditor: (props: unknown) => {
  mock.editor(props)
  return <p>Editor</p>
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.query.mockReturnValue({ data: { items: [{ id: 'candidate-id', revision: 2, origin: 'manual', requester: 'web', resolvedHash: 'config-hash', baseManifestHash: 'engine-hash', parentRevisionId: 'parent-id', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }] }], nextCursor: { createdAtMs: 100, id: 'cursor-id' } } })
})
const view = () => render(<I18nProvider i18n={i18n}><ProfileLibrary side="left" /></I18nProvider>)
it('shows exact immutable identities and branches the selected candidate without activating', () => {
  view()
  expect(screen.getByText('config-hash')).toBeTruthy()
  expect(screen.getByText('engine-hash')).toBeTruthy()
  expect(screen.getByText(/not evidence of validation/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit a new candidate from this revision' }))
  expect(mock.editor).toHaveBeenLastCalledWith({ side: 'left', revisionId: 'candidate-id' })
  fireEvent.click(screen.getByRole('button', { name: 'Start from current profile' }))
  expect(mock.editor).toHaveBeenLastCalledWith({ side: 'left', revisionId: undefined })
})
it('uses both stable pagination fields and can return to newest profiles', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Older profiles' }))
  expect(mock.query).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 100, beforeId: 'cursor-id' })
  fireEvent.click(screen.getByRole('button', { name: 'Newest profiles' }))
  expect(mock.query).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: undefined, beforeId: undefined })
})
