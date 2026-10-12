import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ReplaySessionPicker } from '../ReplaySessionPicker'
const mock = vi.hoisted(() => ({ sessions: vi.fn(), capability: vi.fn(), comparison: true }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } },
  biometricTuning: { listSessions: { useQuery: mock.sessions }, getSessionCapabilities: { useQuery: mock.capability } },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
function Harness() {
  const [selected, setSelected] = useState<number[]>([])
  return <I18nProvider i18n={i18n}><ReplaySessionPicker side="left" selected={selected} onChange={setSelected} /></I18nProvider>
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.comparison = true
  mock.sessions.mockReturnValue({ data: { items: [{ id: 7, startMs: 1791673200000, endMs: 1791702000000 }], nextCursor: { startMs: 1791673200000, id: 7 } } })
  mock.capability.mockImplementation(() => ({ data: { comparison: mock.comparison, stageReplay: mock.comparison, processed: { vitals: { count: mock.comparison ? 20 : 0 }, movement: { count: 5 }, legacyUnknownProvenanceCount: 20 }, referenceMetrics: [], limitations: ['Raw context missing'] } }))
})
it('loads capabilities on demand and selects an inspected night with explicit limitations', () => {
  render(<Harness />)
  expect(mock.capability).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect session 7' }))
  expect(mock.capability).toHaveBeenCalledWith({ side: 'left', id: 7 })
  expect(screen.getByText(/Signal replay unavailable/)).toBeTruthy()
  expect(screen.getByText('No overlapping reference records.')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include this session' }))
  expect(screen.getByText('Selected sessions: 1 / 60')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove session 7' }))
  expect(screen.getByText('Selected sessions: 0 / 60')).toBeTruthy()
})
it('does not offer processed replay when no stored vitals are available', () => {
  mock.comparison = false
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect session 7' }))
  expect(screen.getByText('No stored vitals for comparison')).toBeTruthy()
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
})
it('paginates using the complete stable session cursor', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Older nights' }))
  expect(mock.sessions).toHaveBeenLastCalledWith({ side: 'left', beforeStartMs: 1791673200000, beforeId: 7 })
  fireEvent.click(screen.getByRole('button', { name: 'Newest nights' }))
  expect(mock.sessions).toHaveBeenLastCalledWith({ side: 'left', beforeStartMs: undefined, beforeId: undefined })
})
