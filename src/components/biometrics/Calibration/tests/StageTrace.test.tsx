import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { StageTrace } from '../StageTrace'
const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '24h' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } }, biometricTuning: { getBacktestTrace: { useQuery: mock.query } } } }))
const item = { cohortId: 'night-one', configurationHash: 'config-hash', revisionId: null, windowStartMs: 1791673200000, windowEndMs: 1791673800000, startMs: 1791673200000, endMs: 1791673260000, stage: 'wake' }
const page = { contentHash: 'report-hash', configuration: 'default', items: [item, { ...item, startMs: 1791673320000, endMs: 1791673380000, stage: 'deep' }], totalItems: 4, clockOffsetMs: 60000, nextCursor: { offset: 2, contentHash: 'report-hash' } }
const nights = [{ cohortId: 'night-one', evaluations: [{ label: 'default' as const, configHash: 'config-hash', windows: [] }, { label: 'candidate' as const, configHash: 'candidate-hash', windows: [] }] }]
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><StageTrace id="job-id" hash="report-hash" nights={nights} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.query.mockReturnValue({ data: page })
})
it('pins requests to the report and leaves trace gaps unconnected with original timestamp details', () => {
  const rendered = render(view())
  expect(mock.query).toHaveBeenCalledWith({ id: 'job-id', expectedContentHash: 'report-hash', cohortId: 'night-one', configuration: 'default', offset: 0, limit: 200 }, { staleTime: 60000 })
  const chart = screen.getByRole('img')
  const lines = chart.querySelectorAll('line')
  expect(lines).toHaveLength(2)
  expect(Number(lines[0].getAttribute('x2'))).toBeLessThan(Number(lines[1].getAttribute('x1')))
  expect(screen.getByText(/frozen offset of 60000 ms/)).toBeTruthy()
  fireEvent.click(screen.getByText('Exact trace intervals'))
  expect(rendered.container.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(item.startMs).toISOString())
})
it('uses the returned cursor and resets paging when the selected configuration changes', async () => {
  mock.query.mockImplementation(input => ({ data: { ...page, configuration: input.configuration } }))
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Next trace page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(2)
  fireEvent.change(screen.getByLabelText('Trace configuration'), { target: { value: 'candidate' } })
  await waitFor(() => expect(mock.query.mock.lastCall?.[0]).toMatchObject({ configuration: 'candidate', offset: 0, expectedContentHash: 'report-hash' }))
})
it('does not draw mismatched, expired, or empty trace results', () => {
  mock.query.mockReturnValue({ data: { ...page, contentHash: 'other-hash' } })
  const rendered = render(view())
  expect(screen.getByText('Trace identity does not match the selected report.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ error: { message: 'Replay report was released' } })
  rendered.rerender(view())
  expect(screen.getByText('Replay report was released')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ data: { ...page, items: [], totalItems: 0, nextCursor: null } })
  rendered.rerender(view())
  expect(screen.getByText('No stage intervals were produced for this selection.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})
