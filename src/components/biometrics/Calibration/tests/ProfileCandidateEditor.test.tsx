import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_STAGE_CLASSIFIER } from '@/src/lib/sleep-stage-rules'
import { ProfileCandidateEditor } from '../ProfileCandidateEditor'
const mock = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn(), invalidate: vi.fn(), parentHash: 'a'.repeat(64), parentSide: 'right' }))
const manifestHash = 'a'.repeat(64)
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listProfileRevisions: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    getManifest: { useQuery: () => ({ data: { manifestHash, manifest: { defaults: { sleep_stages: DEFAULT_STAGE_CLASSIFIER }, parameters: { properties: {
      heart_rate: { properties: { trackingToleranceBpm: { type: 'number', minimum: 5, maximum: 30, default: 15, unit: 'bpm', description: 'Width' } } },
      breathing_rate: { properties: {} }, hrv_index: { properties: {} },
    } } } } }) },
    getProfileOverview: { useQuery: () => ({ data: { desired: { binding: { desiredRevisionId: 'parent' }, warning: null } } }) },
    getProfileRevision: { useQuery: () => ({ data: { side: mock.parentSide, baseManifestHash: mock.parentHash, overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }, { path: 'sleep_stages.ruleset.lowSignalBelow', value: 0.2 }] } }) },
    resolveProfile: { useMutation: () => ({ mutateAsync: mock.resolve, isPending: false }) },
    createProfileRevision: { useMutation: () => ({ mutateAsync: mock.create, isPending: false }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.parentHash = manifestHash
  mock.parentSide = 'right'
  mock.resolve.mockImplementation(async input => ({ hash: 'resolved-hash', overrides: input.overrides }))
  mock.create.mockResolvedValue({ id: 'candidate-id' })
})
const view = () => render(<I18nProvider i18n={i18n}><ProfileCandidateEditor side="right" /></I18nProvider>)
it('removes explicit overrides, preserves stage intent and saves only a reviewed candidate', async () => {
  view()
  expect(screen.getByText(/original: 18/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove override' }))
  expect(screen.getByText('Inherited default')).toBeTruthy()
  expect((screen.getByLabelText('heart_rate.trackingToleranceBpm') as HTMLInputElement).value).toBe('15')
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  expect(mock.create).toHaveBeenCalledWith({ side: 'right', baseManifestHash: manifestHash, parentRevisionId: 'parent', overrides: [{ path: 'sleep_stages.ruleset.lowSignalBelow', value: 0.2 }], origin: 'manual', requester: 'web-calibration', idempotencyKey: expect.any(String) })
})
it('invalidates review after an edit and blocks empty numbers', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  fireEvent.change(screen.getByLabelText('heart_rate.trackingToleranceBpm'), { target: { value: '20' } })
  expect(screen.queryByRole('button', { name: 'Save candidate without applying' })).toBeNull()
  fireEvent.change(screen.getByLabelText('heart_rate.trackingToleranceBpm'), { target: { value: '' } })
  expect((screen.getByRole('button', { name: 'Review candidate' }) as HTMLButtonElement).disabled).toBe(true)
})
it('keeps the exact idempotency key when a failed save is retried', async () => {
  view()
  mock.create.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Network unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  expect(mock.create.mock.calls[0][0]).toEqual(mock.create.mock.calls[1][0])
})

it('refuses to rebase an old-engine or wrong-side candidate silently', () => {
  mock.parentHash = 'old-engine'
  const result = view()
  expect(screen.getByText('The saved profile or parameter definitions are incompatible with this editor.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Review candidate' })).toBeNull()
  mock.parentHash = manifestHash
  mock.parentSide = 'left'
  result.rerender(<I18nProvider i18n={i18n}><ProfileCandidateEditor side="right" revisionId="other-candidate" /></I18nProvider>)
  expect(screen.getByText('The saved profile or parameter definitions are incompatible with this editor.')).toBeTruthy()
})

it('saves ordered stage edits in the candidate alongside numerical settings', async () => {
  view()
  fireEvent.click(screen.getByText('Candidate sleep-stage rules'))
  fireEvent.click(screen.getByLabelText('Candidate rule 2 stage'))
  fireEvent.click(screen.getByRole('button', { name: 'Move candidate rule 2 up' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  const overrides = mock.create.mock.calls[0][0].overrides
  expect(overrides).toContainEqual({ path: 'heart_rate.trackingToleranceBpm', value: 18 })
  expect(overrides).toContainEqual({ path: 'sleep_stages.ruleset.lowSignalBelow', value: 0.2 })
  const original = DEFAULT_STAGE_CLASSIFIER.ruleset.rules
  expect(overrides).toContainEqual({ path: 'sleep_stages.ruleset.rules', value: [original[1], original[0], ...original.slice(2)] })
})

it('removes a stage override to restore inheritance without touching numerical intent', async () => {
  view()
  fireEvent.click(screen.getByText('Candidate sleep-stage rules'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove stage override' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  expect(mock.resolve).toHaveBeenLastCalledWith({ baseManifestHash: manifestHash, overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }] })
})
