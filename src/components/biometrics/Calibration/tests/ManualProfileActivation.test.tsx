import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ManualProfileActivation } from '../ManualProfileActivation'
const mock = vi.hoisted(() => ({ activate: vi.fn(), invalidate: vi.fn(), status: vi.fn(), reset: vi.fn(), rollback: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { getProfileOverview: { invalidate: mock.invalidate }, listActivationHistory: { invalidate: mock.invalidate } } }),
  biometricTuning: { resetProfile: { useMutation: () => ({ mutateAsync: mock.reset }) }, rollbackProfile: { useMutation: () => ({ mutateAsync: mock.rollback }) }, activateProfile: { useMutation: () => ({ mutateAsync: mock.activate, isPending: false }) }, getActivationStatus: { useQuery: mock.status } },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const hash = 'a'.repeat(64)
const view = (generation = 2) => <I18nProvider i18n={i18n}><ManualProfileActivation side="left" revisionId="candidate-id" review={{ generation, hash }} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.activate.mockResolvedValue({ id: 'event-id' })
  mock.status.mockReturnValue({ data: { observedState: 'pending_boundary', isCurrent: true } })
})
it('disables acknowledgement until an exact comparison is available', () => {
  const rendered = render(<I18nProvider i18n={i18n}><ManualProfileActivation side="left" revisionId="candidate-id" /></I18nProvider>)
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Apply unvalidated revision' }) as HTMLButtonElement).disabled).toBe(true)
  rendered.rerender(view())
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
})
it('requires deliberate acknowledgement and sends the exact reviewed intent without inventing adoption', async () => {
  render(view())
  expect((screen.getByRole('button', { name: 'Apply unvalidated revision' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply unvalidated revision' }))
  await screen.findByText('Waiting for a processing boundary')
  expect(screen.queryByText('Applied')).toBeNull()
  expect(mock.activate).toHaveBeenCalledWith({ side: 'left', revisionId: 'candidate-id', expectedGeneration: 2, expectedResolvedHash: hash, boundary: 'next_session', requester: 'web-calibration', idempotencyKey: expect.any(String), allowUnvalidated: true })
  expect(mock.status).toHaveBeenCalledWith({ side: 'left', id: 'event-id' }, { refetchInterval: 5000 })
})
it('invalidates acknowledgement when the reviewed generation changes', () => {
  const rendered = render(view())
  fireEvent.click(screen.getByRole('checkbox'))
  rendered.rerender(view(3))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('button', { name: 'Apply unvalidated revision' }) as HTMLButtonElement).disabled).toBe(true)
})
it('retries an uncertain response with identical intent and reports superseded acknowledgement', async () => {
  mock.activate.mockRejectedValueOnce(new Error('Network unavailable'))
  mock.status.mockReturnValue({ data: { observedState: 'applied', isCurrent: false } })
  render(view())
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply unvalidated revision' }))
  await screen.findByRole('button', { name: 'Retry exact activation request' })
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact activation request' }))
  await screen.findByText('This request has been superseded by another profile change.')
  expect(mock.activate.mock.calls[0][0]).toEqual(mock.activate.mock.calls[1][0])
})

it.each(['reset', 'rollback'] as const)('routes %s to its dedicated endpoint including previous defaults', async (action) => {
  mock.reset.mockResolvedValue({ id: 'reset-event' })
  mock.rollback.mockResolvedValue({ id: 'rollback-event' })
  render(<I18nProvider i18n={i18n}><ManualProfileActivation action={action} side="right" revisionId={null} review={{ generation: 4, hash }} /></I18nProvider>)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: action === 'reset' ? 'Restore system defaults' : 'Restore previous profile' }))
  await screen.findByText('Waiting for a processing boundary')
  expect(mock.activate).not.toHaveBeenCalled()
  const expected = { side: 'right', expectedGeneration: 4, expectedResolvedHash: hash, boundary: 'next_session', requester: 'web-calibration', idempotencyKey: expect.any(String), allowUnvalidated: true }
  if (action === 'reset') expect(mock.reset).toHaveBeenCalledWith(expected)
  else expect(mock.rollback).toHaveBeenCalledWith({ ...expected, revisionId: null })
})
