import { render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { expect, it } from 'vitest'
import { ReplayResources } from '../ReplayResources'
const i18n = setupI18n({ locale: 'en', messages: {} })
it('labels units and measured scope while showing unknown memory as unavailable', () => {
  render(
    <I18nProvider i18n={i18n}>
      <ReplayResources resources={{ version: 'waveform-resource-summary-v1',
        scope: 'sequential_python_processes_excluding_coordinator_and_scorer', expectedProcesses: 3, measuredProcesses: 3,
        totalWallMs: 1200, totalCpuMs: 800, largestProcessPeakRssBytes: null, ingestionHealthMeasured: false }}
      />
    </I18nProvider>
  )
  expect(screen.getByText('1.2')).toBeTruthy()
  expect(screen.getByText('0.8')).toBeTruthy()
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(screen.getByText(/do not establish live ingestion health/)).toBeTruthy()
})
it('keeps older reports inspectable without inventing resource measurements', () => {
  render(<I18nProvider i18n={i18n}><ReplayResources /></I18nProvider>)
  expect(screen.getByText('This report predates replay process measurements.')).toBeTruthy()
})

it('shows sampled ingestion evidence and sampling gaps without claiming continuous health', () => {
  render(
    <I18nProvider i18n={i18n}>
      <ReplayResources operations={{ version: 'backtest-job-operations-v1', wallMs: 10000,
        scope: 'admission_through_prepublication', memory: { version: 'process-group-rss-observations-v1', scope: 'sum_rss_of_replay_process_group',
          attempts: 10, samples: 9, allSamplesAvailable: false, peakObservedRssBytes: 104857600, maximumObservationGapMs: 2000, intervalMs: 1000, exactKernelPeak: false }, ingestion: { source: 'supervisor_live_piezo_receipt_age', checks: 3, samples: 2,
          allChecksMeasured: false, qualificationId: null, maximumObservedAgeMs: 1200, maximumObservationGapMs: 7000,
          nominalIntervalMs: 5000, continuousMeasurement: false } }}
      />
    </I18nProvider>
  )
  expect(screen.getByText('Observed process-group peak RSS: 100 MiB')).toBeTruthy()
  expect(screen.getByText(/short peaks between observations may be missed/)).toBeTruthy()
  expect(screen.getByText('Ingestion samples: 2 of 3 admission checks')).toBeTruthy()
  expect(screen.getByText('Largest observed ingestion age: 1.2 seconds')).toBeTruthy()
  expect(screen.getByText('Largest observation gap: 7 seconds')).toBeTruthy()
  expect(screen.getByText(/Some health evidence is unavailable/)).toBeTruthy()
  expect(screen.getByText(/Unobserved intervals are not continuous health measurements/)).toBeTruthy()
})
