import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NumericTrace } from '../NumericTrace'
const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '24h' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } }, biometricTuning: { getBacktestNumericTrace: { useQuery: mock.query } } } }))
const item = { cohortId: 'night', configHash: 'config', side: 'left', sourceSide: 'right', timestampMs: 1791673200000,
  heartRate: 60, breathingRate: null, hrvIndex: null, qualityScore: 0, flags: null, limitations: ['unknown_context'] }
const page = { jobId: 'job', contentHash: 'hash', configuration: 'default', side: 'left', offset: 0, items: [item, { ...item, heartRate: null, timestampMs: item.timestampMs + 60000 }], totalItems: 4, clockOffsetMs: 60000, nextCursor: { offset: 2, contentHash: 'hash' } }
const nights = [{ cohortId: 'night', evaluations: [{ label: 'default' as const, configHash: 'config', windows: [] }, { label: 'candidate' as const, configHash: 'candidate', windows: [] }] }]
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><NumericTrace id="job" hash="hash" nights={nights} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.query.mockReturnValue({ data: page })
})
it('shows exact timestamps, missing values and routing without interpolating gaps', () => {
  const rendered = render(view())
  expect(mock.query.mock.lastCall?.[0]).toEqual({ id: 'job', expectedContentHash: 'hash', cohortId: 'night', configuration: 'default', offset: 0, limit: 200 })
  expect(screen.getByRole('img').querySelectorAll('circle')).toHaveLength(1)
  expect(screen.getByRole('img').querySelectorAll('line,path')).toHaveLength(0)
  expect(screen.getByText('Missing')).toBeTruthy()
  expect(screen.getAllByText('Right')).toHaveLength(2)
  expect(rendered.container.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(item.timestampMs).toISOString())
  fireEvent.change(screen.getByLabelText('Numeric trace metric'), { target: { value: 'breathingRate' } })
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText('No values for this metric on the current page.')).toBeTruthy()
})
it('pages by the returned hash cursor and resets on configuration change', () => {
  mock.query.mockImplementation(input => ({ data: { ...page, offset: input.offset, configuration: input.configuration,
    items: page.items.map(row => ({ ...row, configHash: input.configuration === 'candidate' ? 'candidate' : 'config' })), nextCursor: null } }))
  mock.query.mockReturnValueOnce({ data: page })
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Next numeric page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(2)
  fireEvent.change(screen.getByLabelText('Numeric trace configuration'), { target: { value: 'candidate' } })
  expect(mock.query.mock.lastCall?.[0]).toMatchObject({ offset: 0, configuration: 'candidate' })
})
it('rejects stale or wrong-side rows and does not follow invalid cursors', () => {
  mock.query.mockReturnValue({ data: { ...page, items: [{ ...item, side: 'right' }] } })
  const rendered = render(view())
  expect(screen.getByText('Numeric trace identity does not match the selected report.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ data: { ...page, nextCursor: { offset: 0, contentHash: 'hash' } } })
  rendered.rerender(view())
  expect(screen.getByRole('button', { name: 'Next numeric page' }).hasAttribute('disabled')).toBe(true)
  mock.query.mockReturnValue({ error: { message: 'Report released' } })
  rendered.rerender(view())
  expect(screen.getByText('Report released')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})
