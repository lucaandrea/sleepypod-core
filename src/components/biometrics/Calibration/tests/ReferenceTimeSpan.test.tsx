import { render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { TimeFormatProvider } from '@/src/providers/TimeFormatProvider'
import { ReferenceTimeSpan } from '../ReferenceTimeSpan'
const mock = vi.hoisted(() => ({ timezone: 'America/Los_Angeles', timeFormat: '24h' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: mock } }) } } } }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const timestamp = Date.UTC(2026, 9, 10, 23, 0)
function view(startMs: number | null = timestamp, endMs: number | null = timestamp + 60000) {
  return render(<I18nProvider i18n={i18n}><TimeFormatProvider><ReferenceTimeSpan startMs={startMs} endMs={endMs} /></TimeFormatProvider></I18nProvider>)
}
beforeEach(() => {
  mock.timezone = 'America/Los_Angeles'
  mock.timeFormat = '24h'
})
it('uses the device timezone and 24-hour preference without implying continuous coverage', () => {
  view()
  const expected = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: mock.timezone, hour12: false }).format(timestamp)
  expect(screen.getByText(text => text.includes(expected) && text.includes('(America/Los_Angeles)'))).toBeTruthy()
  expect(screen.getByText(/not continuous coverage/)).toBeTruthy()
})
it('labels UTC fallback for invalid device timezone instead of crashing', () => {
  mock.timezone = 'invalid timezone'
  view()
  expect(screen.getByText(/\(UTC\)/)).toBeTruthy()
})
it('does not substitute epoch zero for missing coverage', () => {
  view(null, null)
  expect(screen.getByText('No accepted time range.')).toBeTruthy()
  expect(screen.queryByText(/Reference extent:/)).toBeNull()
})
