import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExperimentBuilder } from '../ExperimentBuilder'
const mock = vi.hoisted(() => ({ create: vi.fn(), invalidate: vi.fn(), data: undefined as unknown }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listExperiments: { invalidate: mock.invalidate } } }),
  biometricTuning: { createExperiment: { useMutation: () => ({ mutateAsync: mock.create, data: mock.data, isPending: false }) } },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.data = undefined
  mock.create.mockImplementation(async () => {
    mock.data = { id: 'experiment-id', protocolHash: 'protocol-hash' }
    return mock.data
  })
})
function view(stageReplay = true) {
  return render(<I18nProvider i18n={i18n}><ExperimentBuilder datasetId="dataset-id" stageReplay={stageReplay} /></I18nProvider>)
}
it('requires an explicit stage-quality assumption and bounds uncertainty settings', async () => {
  view()
  fireEvent.change(screen.getByLabelText('Evaluation mode'), { target: { value: 'stage_replay' } })
  expect((screen.getByRole('button', { name: 'Save evaluation protocol' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Assumed calibration quality (0–1)'), { target: { value: '0.7' } })
  fireEvent.click(screen.getByRole('checkbox'))
  expect((screen.getByRole('button', { name: 'Save evaluation protocol' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Reproducible sampling seed'), { target: { value: 'study-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluation protocol' }))
  await screen.findByText('Experiment saved: experiment-id')
  expect(mock.create).toHaveBeenCalledWith({ datasetId: 'dataset-id', protocol: { version: 'descriptive-evaluation-v1', mode: 'stage_replay', assumedStageCalibrationQuality: 0.7, pointToleranceMs: 30000, clockOffsetMs: 0, nightUncertainty: { version: 'paired-night-percentile-v1', seed: 'study-1', resamples: 1000, minimumNights: 3 } }, idempotencyKey: expect.any(String) })
})
it('does not offer unsupported stage replay and rejects blank timing inputs', () => {
  view(false)
  expect((screen.getByRole('option', { name: 'Replay sleep stages' }) as HTMLOptionElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Point matching tolerance (ms, 0–300000)'), { target: { value: '' } })
  expect((screen.getByRole('button', { name: 'Save evaluation protocol' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mock.create).not.toHaveBeenCalled()
})
it('retries the same immutable protocol with the same key after an uncertain response', async () => {
  view()
  mock.create.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluation protocol' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluation protocol' }))
  await screen.findByText('Experiment saved: experiment-id')
  expect(mock.create.mock.calls[0][0]).toEqual(mock.create.mock.calls[1][0])
})
it('uses retained signal replay and requires a quality assumption only when stages are selected', async () => {
  render(<I18nProvider i18n={i18n}><ExperimentBuilder datasetId="waveforms" stageReplay waveformReplay /></I18nProvider>)
  expect((screen.getByLabelText('Evaluation mode') as HTMLSelectElement).value).toBe('signal_replay')
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluation protocol' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledOnce())
  expect(mock.create.mock.calls[0][0].protocol).toMatchObject({ mode: 'signal_replay', waveformStages: false, assumedStageCalibrationQuality: 0 })
  fireEvent.click(screen.getByLabelText('Also replay sleep stages'))
  expect((screen.getByRole('button', { name: 'Save evaluation protocol' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Assumed calibration quality (0–1)'), { target: { value: '0.5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluation protocol' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(2))
  expect(mock.create.mock.calls[1][0].protocol).toMatchObject({ mode: 'signal_replay', waveformStages: true, assumedStageCalibrationQuality: 0.5 })
})
it('pins numeric night uncertainty without requiring stage replay', async () => {
  render(<I18nProvider i18n={i18n}><ExperimentBuilder datasetId="waveforms" stageReplay waveformReplay /></I18nProvider>)
  fireEvent.click(screen.getByLabelText('Estimate exploratory whole-night uncertainty'))
  fireEvent.change(screen.getByLabelText('Reproducible sampling seed'), { target: { value: 'numeric-nights' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluation protocol' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledOnce())
  expect(mock.create.mock.calls[0][0].protocol).toMatchObject({ mode: 'signal_replay', waveformStages: false,
    nightUncertainty: { version: 'paired-night-percentile-v1', seed: 'numeric-nights', minimumNights: 3, resamples: 1000 } })
})
