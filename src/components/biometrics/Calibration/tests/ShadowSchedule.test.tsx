import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ShadowSchedule } from '../ShadowSchedule'
const mock = vi.hoisted(() => ({ prepare: vi.fn(), create: vi.fn(), templates: vi.fn(), profiles: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricShadow: { list: { invalidate: mock.invalidate } } }),
  biometricShadow: { templates: { useQuery: mock.templates }, prepare: { useMutation: () => ({ mutateAsync: mock.prepare, isPending: false }) },
    create: { useMutation: () => ({ mutateAsync: mock.create, isPending: false }) } },
  biometricTuning: { listProfileRevisions: { useQuery: mock.profiles } },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><ShadowSchedule side="left" /></I18nProvider>
const plan = { side: 'left', subjectId: 'sleeper', candidateRevisionId: null, candidateConfigHash: 'candidate-hash', startMs: Date.parse('2099-01-01T00:00:00Z'), endMs: Date.parse('2099-01-01T00:10:00Z'),
  expectedBindings: { left: { generation: 4 }, right: { generation: 5 } } }
function fill() {
  fireEvent.change(screen.getByLabelText('Observation template'), { target: { value: 'test' } })
  fireEvent.change(screen.getByLabelText('Sleeper identity'), { target: { value: 'sleeper' } })
  fireEvent.click(screen.getByLabelText('System defaults'))
  fireEvent.change(screen.getByLabelText('Start (UTC)'), { target: { value: '2099-01-01T00:00' } })
  fireEvent.change(screen.getByLabelText('End (UTC)'), { target: { value: '2099-01-01T00:10' } })
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.templates.mockReturnValue({ data: { items: [{ id: 'test', label: 'Test template', maximumWindowMs: 600000 }] } })
  mock.profiles.mockReturnValue({ data: { items: [], nextCursor: null } })
  mock.prepare.mockResolvedValue({ status: 'prepared_not_admitted', plan, planHash: 'plan-hash' })
  mock.create.mockResolvedValue({ id: 'saved-run' })
})
it('prepares explicit UTC inputs and schedules only after review', async () => {
  render(view())
  expect((screen.getByRole('button', { name: 'Prepare observation plan' }) as HTMLButtonElement).disabled).toBe(true)
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare observation plan' }))
  await screen.findByText('Review prepared plan')
  expect(mock.prepare).toHaveBeenCalledWith({ templateId: 'test', side: 'left', subjectId: 'sleeper', candidateRevisionId: null, startMs: plan.startMs, endMs: plan.endMs })
  expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Schedule reviewed observation' }))
  await screen.findByRole('status')
  expect(mock.create).toHaveBeenCalledWith({ plan, idempotencyKey: expect.stringMatching(/^[a-f0-9]{48}$/) })
  expect(mock.invalidate).toHaveBeenCalledWith({ side: 'left' })
  expect(screen.getByRole('status').textContent).toContain('execution is not implied')
})
it('invalidates review when draft inputs change', async () => {
  render(view())
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare observation plan' }))
  await screen.findByText('Review prepared plan')
  fireEvent.change(screen.getByLabelText('Sleeper identity'), { target: { value: 'other' } })
  expect(screen.queryByRole('button', { name: 'Schedule reviewed observation' })).toBeNull()
  expect(mock.create).not.toHaveBeenCalled()
})
it('retains the exact request after an uncertain failure without preparing again', async () => {
  mock.create.mockRejectedValueOnce(new Error('connection lost'))
  render(view())
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare observation plan' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Schedule reviewed observation' }))
  await screen.findByText(/Scheduling was not confirmed/)
  const original = structuredClone(mock.create.mock.calls[0][0])
  fireEvent.change(screen.getByLabelText('Sleeper identity'), { target: { value: 'changed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Retry same scheduling request' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(2))
  expect(mock.create.mock.calls[1][0]).toEqual(original)
  expect(mock.prepare).toHaveBeenCalledOnce()
})
it('allows a definitely rejected plan to be corrected and blocks oversized windows', async () => {
  mock.create.mockRejectedValueOnce({ data: { code: 'BAD_REQUEST' } })
  render(view())
  fill()
  fireEvent.change(screen.getByLabelText('End (UTC)'), { target: { value: '2099-01-01T01:00' } })
  expect((screen.getByRole('button', { name: 'Prepare observation plan' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('End (UTC)'), { target: { value: '2099-01-01T00:10' } })
  fireEvent.click(screen.getByRole('button', { name: 'Prepare observation plan' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Schedule reviewed observation' }))
  await screen.findByText('The pod rejected this plan. Adjust it and prepare again.')
  expect(screen.queryByText('Review prepared plan')).toBeNull()
  expect((screen.getByRole('button', { name: 'Prepare observation plan' }) as HTMLButtonElement).disabled).toBe(false)
})
it('does not invent a template when none is configured', () => {
  mock.templates.mockReturnValue({ data: { items: [] } })
  render(view())
  expect(screen.getByText('No prospective observation templates are configured on this pod.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Prepare observation plan' })).toBeNull()
})
it('preserves subsecond UTC timestamps and exact sleeper identity', async () => {
  render(view())
  fill()
  fireEvent.change(screen.getByLabelText('Sleeper identity'), { target: { value: ' sleeper ' } })
  fireEvent.change(screen.getByLabelText('Start (UTC)'), { target: { value: '2099-01-01T00:00:00.250' } })
  fireEvent.change(screen.getByLabelText('End (UTC)'), { target: { value: '2099-01-01T00:09:59.750' } })
  fireEvent.click(screen.getByRole('button', { name: 'Prepare observation plan' }))
  await screen.findByText('Review prepared plan')
  expect(mock.prepare).toHaveBeenCalledWith(expect.objectContaining({ subjectId: ' sleeper ',
    startMs: Date.parse('2099-01-01T00:00:00.250Z'), endMs: Date.parse('2099-01-01T00:09:59.750Z') }))
})
