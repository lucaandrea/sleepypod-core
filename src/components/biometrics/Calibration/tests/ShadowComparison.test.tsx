import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ShadowComparison } from '../ShadowComparison'
const mock = vi.hoisted(() => ({ compare: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricShadow: { compare: { useMutation: () => ({ mutateAsync: mock.compare, isPending: false }) } } } }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><ShadowComparison id="run" side="left" subjectId="sleeper" /></I18nProvider>
const rows = [{ recordKey: 'hr', metric: 'heart_rate', value: 63, unit: 'bpm', timestampMs: 1700000000000 }]
function fill() {
  fireEvent.change(screen.getByLabelText('Reference source'), { target: { value: 'Watch' } })
  fireEvent.change(screen.getByLabelText('Reference format'), { target: { value: 'json' } })
  fireEvent.change(screen.getByLabelText('Comparison reference records'), { target: { value: JSON.stringify(rows) } })
}
function result() {
  return { capturedAtMs: 1700000010000, referenceSummary: { accepted: 1, rejected: 0, duplicates: 0, unscorable: 0, contentHash: 'reference-hash' },
    reportHash: 'comparison-hash', excludedBoundaryReferences: 2, alignment: { clockOffsetMs: 500, pointToleranceMs: 1000 }, metrics: [{ metric: 'heart_rate', windowMs: null,
      referenceExclusions: {}, comparison: { commonSupport: { baseline: { pairedCount: 0, metrics: null }, candidate: { status: 'no_overlap', pairedCount: 0, metrics: null } },
        ownSupport: { baseline: { referenceCoverage: 0.8 }, candidate: { referenceCoverage: 0.2 } }, lostObservationTimestamps: 3, addedObservationTimestamps: 0, coverageReduced: true } }] }
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.compare.mockResolvedValue(result())
})
it('binds the reference to the run identity and shows missing comparisons without invented scores', async () => {
  render(view())
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Compare reference' }))
  await screen.findByText('Reference comparison snapshot')
  expect(mock.compare).toHaveBeenCalledWith({ id: 'run', reference: { side: 'left', subjectId: 'sleeper', source: 'Watch', timePolicy: { disambiguation: 'reject' }, rows } })
  expect(screen.getByText('No matching observations.')).toBeTruthy()
  expect(screen.getByText('Mean absolute error on shared timestamps: active Unavailable, candidate Unavailable.')).toBeTruthy()
  expect(screen.getByText(/active 80%, candidate 20%/)).toBeTruthy()
  expect(screen.getByText(/lower error alone does not show improvement/)).toBeTruthy()
  expect(screen.getByText('Reference records outside the captured window: 2')).toBeTruthy()
  expect(screen.getByText(/Reference clock offset: 0.5 seconds/)).toBeTruthy()
})
it('invalidates an old comparison when the source records change', async () => {
  render(view())
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Compare reference' }))
  await screen.findByText('Reference comparison snapshot')
  fireEvent.change(screen.getByLabelText('Reference source'), { target: { value: 'Other' } })
  expect(screen.queryByText('Reference comparison snapshot')).toBeNull()
})
it('bounds serialized reference size before requesting coordinator work', async () => {
  render(view())
  fill()
  fireEvent.change(screen.getByLabelText('Comparison reference records'), { target: { value: JSON.stringify([{ ...rows[0], annotation: '😀'.repeat(20000) }]) } })
  fireEvent.click(screen.getByRole('button', { name: 'Compare reference' }))
  await screen.findByText('Reference comparison is limited to a 64 KiB request.')
  expect(mock.compare).not.toHaveBeenCalled()
})
it('prevents overlapping requests and surfaces comparison errors', async () => {
  let reject!: (error: Error) => void
  mock.compare.mockImplementationOnce(() => new Promise((_resolve, fail) => {
    reject = fail
  }))
  render(view())
  fill()
  const button = screen.getByRole('button', { name: 'Compare reference' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mock.compare).toHaveBeenCalledOnce()
  reject(new Error('Reference subject mismatch'))
  await waitFor(() => expect(screen.getByText('Reference subject mismatch')).toBeTruthy())
  expect(screen.queryByText('Reference comparison snapshot')).toBeNull()
})
it('bounds the expanded coordinator envelope even when CSV text fits', async () => {
  render(view())
  fill()
  fireEvent.change(screen.getByLabelText('Reference format'), { target: { value: 'csv' } })
  const csv = 'recordKey,metric,value,unit,timestampMs\n'
    + Array.from({ length: 1000 }, (_, index) => `${index},heart_rate,63,bpm,1700000000000`).join('\n')
  expect(new TextEncoder().encode(csv).byteLength).toBeLessThan(65536)
  fireEvent.change(screen.getByLabelText('Comparison reference records'), { target: { value: csv } })
  fireEvent.click(screen.getByRole('button', { name: 'Compare reference' }))
  await screen.findByText('Reference comparison is limited to a 64 KiB request.')
  expect(mock.compare).not.toHaveBeenCalled()
})
