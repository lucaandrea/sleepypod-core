import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BacktestReport } from '../BacktestReport'
const mock = vi.hoisted(() => ({ get: vi.fn(), release: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { getBacktestResult: { invalidate: mock.invalidate } } }),
  biometricTuning: { getBacktestResult: { useQuery: mock.get }, releaseBacktestResult: { useMutation: () => ({ mutateAsync: mock.release, isPending: false }) } },
} }))
const report = {
  version: 'processed-backtest-report-v1', status: 'insufficient_evidence', datasetHash: 'dataset', protocolHash: 'protocol', manifestHash: 'manifest', evaluatorBuildHash: 'worker',
  split: 'holdout', evidence: 'descriptive_only', holdoutUse: 1, protocol: { mode: 'stage_replay' }, calibration: { source: 'explicit_assumption', quality: 0 }, limitations: [],
  stageNightSummary: [{ baseline: 'default', candidate: 'candidate', baselineHash: 'default-hash', candidateHash: 'candidate-hash', totalNights: 3, scoredNights: 2, unscoredNights: 1, coverageReducedNights: 1,
    improvedAgreementNights: 0, regressedAgreementNights: 1, unchangedAgreementNights: 1, equalNightMeanAgreementDifference: 0,
    pooledCommonSupport: { baseline: { agreement: 0, macroF1: null, pairedDurationMs: 1000 }, candidate: { agreement: null, macroF1: 0, pairedDurationMs: 1000 } },
    uncertainty: { status: 'insufficient_nights', interval: null, limitations: [] } }],
}
const descriptor = { report, contentHash: 'exact-report-hash', available: true, currentHoldoutUseCount: 2 }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><BacktestReport id="job-id" /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.get.mockReturnValue({ data: descriptor })
  mock.release.mockResolvedValue({})
})
it('keeps zero scores distinct from missing scores and reports current holdout reuse', () => {
  render(view())
  expect(screen.getAllByText('0%')).toHaveLength(2)
  expect(screen.getAllByText('Not scored')).toHaveLength(2)
  expect(screen.getByText('Insufficient evidence for validated improvement')).toBeTruthy()
  expect(screen.getByText(/Repeated holdout exposure/)).toBeTruthy()
  expect(screen.getByText('Assumed stage calibration quality: 0')).toBeTruthy()
  expect(screen.getByText('Insufficient paired nights')).toBeTruthy()
})
it('requires a deliberate second action and releases only the displayed report hash', async () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Release detailed report' }))
  expect(mock.release).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Keep report' }))
  expect(mock.release).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Release detailed report' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently release report' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledWith({ id: 'job-id' }))
  expect(mock.release).toHaveBeenCalledWith({ id: 'job-id', expectedContentHash: 'exact-report-hash' })
})
it('does not interpret unknown report versions or released payloads as valid scores', () => {
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...report, version: 'future' } } })
  const rendered = render(view())
  expect(screen.getByText(/version or structure is not supported/)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
  mock.get.mockReturnValue({ data: { ...descriptor, available: false, report: {} } })
  rendered.rerender(view())
  expect(screen.getByText(/This report was released/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Release detailed report' })).toBeNull()
})
