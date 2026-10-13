import { fireEvent, render, screen, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { expect, it, vi } from 'vitest'
import { NumericReport } from '../NumericReport'
import { numericReportViewSchema, type NumericReportView } from '../report-view'
import { compareNumericConfigurations } from '@/src/biometrics/backtest/numeric-comparison'
import { DEFAULT_ALIGNMENT } from '@/src/biometrics/references/alignment'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '24h' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } } } }))
const row = { metric: 'heart_rate' as const, status: 'compared' as const, metrics: { mae: 0, medianAbsoluteError: 0, p95AbsoluteError: 0, signedBias: -2 }, pairedCount: 1, referenceCoverage: 0.5, outputCoverage: 1, unmatchedReferences: 1, unmatchedObservations: 2, exclusions: {} }
const night = { cohortId: 'night-1', evaluations: [{ label: 'default' as const, configHash: 'exact-config', windows: [{ startMs: 1791673200000, endMs: 1791673800000, observationCount: 3, numeric: [row, { ...row, metric: 'window_ibi_variability_v1' as const, status: 'incompatible' as const, metrics: null, pairedCount: 0, referenceCoverage: null, exclusions: { incompatible_hrv_window: 3 } }] }] }] }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = (report: NumericReportView) => <I18nProvider i18n={i18n}><NumericReport report={report} /></I18nProvider>
it('shows original-reading errors, missing evidence, units, exclusions and sparse coverage honestly', () => {
  render(view({ nights: [night] }))
  fireEvent.click(screen.getByText('Night night-1'))
  const rows = screen.getAllByRole('row')
  expect(within(rows[1]).getAllByText('0')).toHaveLength(3)
  expect(within(rows[1]).getByText('-2')).toBeTruthy()
  expect(within(rows[1]).getByText('50%')).toBeTruthy()
  expect(within(rows[2]).getAllByText('Not scored')).toHaveLength(5)
  expect(screen.getByText('Window IBI variability index (ms)')).toBeTruthy()
  expect(screen.getByText(/Identical numerical results across profiles do not validate/)).toBeTruthy()
  expect(screen.getByText(/not continuous time coverage/)).toBeTruthy()
  fireEvent.click(screen.getByText('Exclusions: Window IBI variability index (ms)'))
  expect(screen.getByText('incompatible_hrv_window')).toBeTruthy()
  expect(screen.getByText('exact-config')).toBeTruthy()
})
it('bounds rendered nights while allowing the entire retained report to be inspected', () => {
  render(view({ nights: Array.from({ length: 11 }, (_, index) => ({ ...night, cohortId: `night-${index + 1}` })) }))
  expect(screen.queryByText('Night night-11')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next report nights' }))
  expect(screen.getByText('Night night-11')).toBeTruthy()
  expect(screen.queryByText('Night night-1')).toBeNull()
  expect(screen.getByRole('button', { name: 'Next report nights' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Previous report nights' }))
  expect(screen.getByText('Night night-1')).toBeTruthy()
})

it('shows dropped readings beside own and shared errors for waveform results', () => {
  const timestampMs = night.evaluations[0].windows[0].startMs
  const references = previewReferenceImport({ side: 'left', source: 'test', subjectId: 'test', rows: [
    { recordKey: 'one', metric: 'heart_rate', timestampMs, value: 60, unit: 'bpm' },
    { recordKey: 'two', metric: 'heart_rate', timestampMs: timestampMs + 60000, value: 60, unit: 'bpm' },
  ] }).measurements
  const comparisons = compareNumericConfigurations('heart_rate', null, [
    { label: 'default', configHash: 'default-hash', observations: [{ timestampMs, value: 60 }, { timestampMs: timestampMs + 60000, value: 100 }] },
    { label: 'candidate', configHash: 'candidate-hash', observations: [{ timestampMs, value: 60 }] },
  ], references, DEFAULT_ALIGNMENT)
  const report = numericReportViewSchema.parse({ nights: [{ ...night, numericComparisons: [{ startMs: timestampMs, endMs: timestampMs + 120000, metrics: comparisons }] }] })
  render(<I18nProvider i18n={i18n}><NumericReport report={report} waveform /></I18nProvider>)
  fireEvent.click(screen.getByText('Night night-1'))
  expect(screen.getByText(/Coverage reduced/)).toBeTruthy()
  expect(screen.getByText('-20')).toBeTruthy()
  expect(screen.getByText(/Dropping readings can lower own-support error/)).toBeTruthy()
  expect(screen.getByText('Recomputed observations: 3')).toBeTruthy()
  expect(screen.queryByText(/Identical numerical results across profiles/)).toBeNull()
  expect(screen.getByRole('columnheader', { name: 'Shared MAE difference' })).toBeTruthy()
})
