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
