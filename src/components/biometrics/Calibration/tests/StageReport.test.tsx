import { fireEvent, render, screen, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { expect, it } from 'vitest'
import { StageReport } from '../StageReport'
import type { StageReportView } from '../report-view'
const zeroRow = { wake: 0, light: 0, deep: 0, rem: 0 }
const score = { agreement: 0, macroF1: 0, pairedDurationMs: 120000,
  confusionMs: { wake: { ...zeroRow, deep: 120000 }, light: zeroRow, deep: zeroRow, rem: zeroRow },
  perStage: (['wake', 'light', 'deep', 'rem'] as const).map(stage => ({ stage, referenceMs: stage === 'wake' ? 120000 : 0, predictedMs: stage === 'deep' ? 120000 : 0, precision: stage === 'deep' ? 0 : null, recall: stage === 'wake' ? 0 : null, f1: stage === 'wake' || stage === 'deep' ? 0 : null })) }
const own = { outputMs: 120000, pairedMs: 120000, referenceMs: 240000, agreement: 0, outputCoverage: 0.5, referenceCoverage: 0.5 }
const night = { cohortId: 'night-one', evaluationDurationMs: 240000, commonSupport: { baseline: score, candidate: score }, ownSupport: { baseline: own, candidate: { ...own, outputCoverage: 0.25, outputMs: 60000 } }, commonAgreementDifference: 0, commonMacroF1Difference: null, coverageReduced: true }
const comparison = { baseline: 'default', candidate: 'candidate', baselineHash: 'default-hash', candidateHash: 'candidate-hash', pooledCommonSupport: { baseline: score, candidate: score }, nights: [night] }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = (report: StageReportView) => <I18nProvider i18n={i18n}><StageReport report={report} /></I18nProvider>
it('preserves matrix orientation, minutes, and absent-stage scores', () => {
  render(view({ stageNightSummary: [comparison] }))
  fireEvent.click(screen.getByText('Pooled stage confusion'))
  const matrices = screen.getAllByRole('table', { name: 'Confusion matrix in minutes: reference rows, predicted columns' })
  const rows = within(matrices[0]).getAllByRole('row')
  expect(within(rows[1]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0', '0', '2', '0'])
  expect(within(rows[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0', '0', '0', '0'])
  const perStage = screen.getAllByRole('table', { name: 'Per-stage scores on common paired intervals' })
  const stageRows = within(perStage[0]).getAllByRole('row')
  expect(within(stageRows[2]).getAllByText('Not scored')).toHaveLength(3)
  expect(within(stageRows[1]).getAllByText('0%')).toHaveLength(2)
})
it('displays own coverage loss alongside zero common-support delta and an unscored F1 delta', () => {
  render(view({ stageNightSummary: [comparison] }))
  fireEvent.click(screen.getByText('Night night-one'))
  expect(screen.getByText('Coverage reduced in at least one evaluated window')).toBeTruthy()
  expect(screen.getByText('Common-support agreement difference: 0%')).toBeTruthy()
  expect(screen.getByText('Common-support macro F1 difference: Not scored')).toBeTruthy()
  const table = screen.getByRole('table', { name: 'Each configuration on its own available intervals' })
  expect(within(table).getByText('25%')).toBeTruthy()
  expect(screen.getByText(/A higher score with reduced coverage is not sufficient/)).toBeTruthy()
})
it('pages all whole-night cohorts without merging their evidence', () => {
  render(view({ stageNightSummary: [{ ...comparison, nights: Array.from({ length: 11 }, (_, i) => ({ ...night, cohortId: `night-${i}` })) }] }))
  expect(screen.queryByText('Night night-10')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next report nights' }))
  expect(screen.getByText('Night night-10')).toBeTruthy()
  expect(screen.queryByText('Night night-0')).toBeNull()
})
