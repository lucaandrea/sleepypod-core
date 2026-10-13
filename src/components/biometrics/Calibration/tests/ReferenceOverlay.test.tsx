import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ReferenceOverlay } from '../ReferenceOverlay'
const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricTuning: { getBacktestReferenceTrace: { useQuery: mock.query } } } }))
const start = 1791673200000
const reference = { startMs: start + 60000, endMs: start + 60000, value: 60, temporalKind: 'point', compatibility: null, source: 'Frozen watch', importRevision: 3, unit: 'bpm', aggregation: 'instantaneous' }
const page = { jobId: 'job', contentHash: 'hash', cohortId: 'night', metric: 'heart_rate', clockOffsetMs: 60000, pointToleranceMs: 30000, offset: 0, items: [reference, { ...reference, temporalKind: 'interval', endMs: start + 120000 }], totalItems: 4, nextCursor: { contentHash: 'hash', offset: 2 } }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><ReferenceOverlay id="job" hash="hash" cohortId="night" metric="heart_rate" clockOffsetMs={60000} points={[{ timestamp: start, value: 60 }]} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.query.mockReturnValue({ data: page })
})
it('shifts only recomputed points and preserves reference interval extents', () => {
  render(view())
  const chart = screen.getByRole('img'), circle = chart.querySelector('circle'), square = chart.querySelector('rect'), interval = chart.querySelector('line')
  if (!circle || !square || !interval) throw new Error('Missing plotted records')
  expect(Number(circle.getAttribute('cx'))).toBe(Number(square.getAttribute('x')) + 4)
  expect(interval.getAttribute('x1')).toBe(circle.getAttribute('cx'))
  expect(Number(interval.getAttribute('x2'))).toBeGreaterThan(Number(interval.getAttribute('x1')))
  expect(chart.querySelectorAll('path')).toHaveLength(0)
  expect(screen.getAllByText(new Date(reference.startMs).toISOString())).toHaveLength(2)
  expect(screen.getByText(/does not create new matched pairs or scores/)).toBeTruthy()
  expect(mock.query.mock.lastCall?.[0]).toMatchObject({ expectedContentHash: 'hash', offset: 0, limit: 200 })
})
it('lists incompatible references without plotting them', () => {
  mock.query.mockReturnValue({ data: { ...page, items: [{ ...reference, compatibility: 'incompatible_definition' }] } })
  render(view())
  expect(screen.getByText('incompatible_definition')).toBeTruthy()
  expect(screen.getByRole('img').querySelectorAll('rect,line')).toHaveLength(0)
  expect(screen.getByRole('img').querySelectorAll('circle')).toHaveLength(1)
})
it('uses independent pinned cursors and rejects stale responses or invalid cursors', () => {
  mock.query.mockImplementation(input => ({ data: { ...page, offset: input.offset, nextCursor: input.offset ? null : page.nextCursor } }))
  const rendered = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Next reference page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: 'Previous reference page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(0)
  mock.query.mockReturnValue({ data: { ...page, nextCursor: { contentHash: 'wrong', offset: 2 } } })
  rendered.rerender(view())
  expect(screen.getByRole('button', { name: 'Next reference page' }).hasAttribute('disabled')).toBe(true)
  mock.query.mockReturnValue({ data: { ...page, clockOffsetMs: 0 } })
  rendered.rerender(view())
  expect(screen.getByText('Reference identity does not match the selected report.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ error: { message: 'Dataset released' } })
  rendered.rerender(view())
  expect(screen.getByText('Dataset released')).toBeTruthy()
})
