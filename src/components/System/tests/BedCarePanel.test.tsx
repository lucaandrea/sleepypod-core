import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { evaluateBedCare } from '@/src/bed-care/evaluate'
import { BedCareSummary } from '../BedCarePanel'

const now = 1_800_000_000_000
const data = evaluateBedCare({ now, hardware: { at: now, water: 'low', priming: false }, blockedSides: ['left'], protectionEnabled: true, recording: null, lastExportAt: now - 1000 })
describe('bed care screen', () => {
  it('offers specific diagnostics and review steps without a repair, prime or reset button', () => {
    const retry = vi.fn()
    render(<BedCareSummary data={data} now={now} unavailable={false} pending={false} language="en" onRetry={retry} />)
    expect(screen.getByText('The Pod reports low water.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open backups' }).getAttribute('href')).toBe('/en/system?tab=databases')
    expect(screen.queryByRole('button', { name: /Prime|Reset|Restart|Dismiss|Delete/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/not proof of a saved off-Pod backup/)).toBeTruthy()
  })
  it.each([['failed', now, true], ['expired', now + 31_000, false], ['future', now - 1, false]] as const)('withdraws current claims after a %s read', (_, at, unavailable) => {
    render(<BedCareSummary data={data} now={at} unavailable={unavailable} pending={false} language="en" onRetry={() => {}} />)
    expect(screen.getByRole('status').textContent).toContain('Care checks unavailable')
    for (const row of screen.getAllByRole('heading', { level: 3 })) {
      const container = row.parentElement
      if (!container) throw new Error('Missing care heading container')
      expect(within(container).getByText('Not verified')).toBeTruthy()
    }
    expect(screen.getAllByText('See last observation')).toHaveLength(5)
  })
})
