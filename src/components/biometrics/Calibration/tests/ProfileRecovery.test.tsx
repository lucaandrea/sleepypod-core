import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ProfileRecovery } from '../ProfileRecovery'
const mock = vi.hoisted(() => ({ generation: 3, previousRevisionId: 'previous-id' as string | null, comparison: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricTuning: { getProfileOverview: { useQuery: () => ({ data: { desired: { binding: { generation: mock.generation, previousRevisionId: mock.previousRevisionId } } } }) } } } }))
vi.mock('../ProfileComparison', () => ({ ProfileComparison: (props: unknown) => {
  mock.comparison(props)
  return <p>Review changes</p>
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.generation = 3
  mock.previousRevisionId = 'previous-id'
})
const view = () => render(<I18nProvider i18n={i18n}><ProfileRecovery side="left" /></I18nProvider>)
it('selects defaults separately from the exact previous revision without making writes', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Review previous profile' }))
  expect(mock.comparison).toHaveBeenLastCalledWith({ side: 'left', action: 'rollback', revisionId: 'previous-id', selectionGeneration: 3 })
  fireEvent.click(screen.getByRole('button', { name: 'Review system defaults' }))
  expect(mock.comparison).toHaveBeenLastCalledWith({ side: 'left', action: 'reset', revisionId: null, selectionGeneration: 3 })
})
it('disables rollback before any activation but allows rollback to previous defaults', () => {
  mock.generation = 0
  const result = view()
  expect((screen.getByRole('button', { name: 'Review previous profile' }) as HTMLButtonElement).disabled).toBe(true)
  result.unmount()
  mock.generation = 1
  mock.previousRevisionId = null
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Review previous profile' }))
  expect(mock.comparison).toHaveBeenLastCalledWith({ side: 'left', action: 'rollback', revisionId: null, selectionGeneration: 1 })
})
