/**
 * SleepStageRules — editing the draft ruleset, saving / resetting payloads,
 * presets, validation, and the debounced preview.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  MOVEMENT_ONLY_STAGE_RULESET,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

const trpcMock = vi.hoisted(() => {
  const setMutate = vi.fn()
  const previewMutate = vi.fn()
  const state = {
    classifier: null as unknown as StageClassifier,
    movementOnly: null as unknown as StageClassifier['ruleset'],
    isDefault: true,
    preview: undefined as unknown,
    savePending: false,
    pending: null as { classifier: StageClassifier, generation: number, warning: string | null } | null,
  }
  return {
    setMutate,
    previewMutate,
    state,
    trpc: {
      useUtils: () => ({ sleepStages: { getClassifier: { invalidate: vi.fn() } } }),
      sleepStages: {
        getClassifier: {
          useQuery: () => ({
            data: {
              classifier: state.classifier,
              pending: state.pending,
              isDefault: state.isDefault,
              presets: [
                { id: 'default', label: 'Default', description: '', classifier: { engine: 'rules', ruleset: state.classifier.ruleset } },
                { id: 'movementOnly', label: 'Movement only', description: '', classifier: { engine: 'rules', ruleset: state.movementOnly } },
              ],
            },
            isLoading: false,
            error: null,
          }),
        },
        setClassifier: { useMutation: () => ({ mutate: setMutate, isPending: state.savePending, error: null }) },
        previewClassifier: { useMutation: () => ({ mutate: previewMutate, data: state.preview, error: null }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right', sideName: (s: string) => s }) }))

import { SleepStageRules } from '../SleepStageRules'

const renderRules = () => render(<SleepStageRules side="left" onSideChange={vi.fn()} />)
const savedRuleset = () => trpcMock.setMutate.mock.calls.at(-1)?.[0].classifier.ruleset

beforeEach(() => {
  vi.useFakeTimers()
  trpcMock.setMutate.mockClear()
  trpcMock.previewMutate.mockClear()
  Object.assign(trpcMock.state, {
    classifier: DEFAULT_STAGE_CLASSIFIER,
    isDefault: true,
    preview: undefined,
    movementOnly: MOVEMENT_ONLY_STAGE_RULESET,
    savePending: false,
    pending: null,
  })
})

afterEach(() => vi.useRealTimers())

describe('SleepStageRules', () => {
  it('shows the default rules with save and reset disabled', () => {
    renderRules()
    expect(screen.getByText('Using the default rules')).toBeTruthy()
    expect((screen.getByLabelText('Rule 2 stage') as HTMLSelectElement).value).toBe('deep')
    expect((screen.getByLabelText('Rule 2 condition 1 value') as HTMLInputElement).value).toBe('0.92')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Reset to default/ }).hasAttribute('disabled')).toBe(true)
  })

  it('saves an edited threshold as a rules classifier', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('Rule 2 condition 1 value'), { target: { value: '0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      classifier: { engine: 'rules', ruleset: expect.objectContaining({ fallback: 'light' }) },
    })
    expect(savedRuleset().rules[1].when[0]).toEqual({ metric: 'hrRatio', op: '<', value: 0.9 })
  })

  it('disables the editor while a save is pending so the refetch cannot drop edits', () => {
    trpcMock.state.savePending = true
    renderRules()
    // Disabled via the enclosing <fieldset>, so check the effective state, not the attribute.
    expect(screen.getByLabelText('Rule 2 condition 1 value').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Fallback stage').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Move rule 2 up').matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Discard' }).matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Saving…' }).matches(':disabled')).toBe(true)
  })

  it('reorders, removes and adds rules and conditions', () => {
    renderRules()
    fireEvent.click(screen.getByLabelText('Move rule 2 up'))
    fireEvent.click(screen.getByLabelText('Remove rule 5'))
    fireEvent.click(screen.getByLabelText('Remove rule 3 condition 3'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Condition' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Rule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const rules = savedRuleset().rules
    expect(rules.map((r: { stage: string }) => r.stage)).toEqual(['deep', 'wake', 'rem', 'rem', 'wake'])
    expect(rules[0].when).toHaveLength(2)
    expect(rules[2].when).toHaveLength(2)
    expect(rules[4]).toEqual({ stage: 'wake', when: [{ metric: 'movement', op: '>', value: 100 }] })
  })

  it('edits signal handling and transitions', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('Heart rate (bpm) minimum'), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Smooth single-epoch blips' }))
    fireEvent.click(screen.getByLabelText('Remove transition 4'))
    fireEvent.change(screen.getByLabelText('Fallback stage'), { target: { value: 'deep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const r = savedRuleset()
    expect(r.outliers.heartRate).toEqual({ min: 40, max: 130 })
    expect(r.smoothIsolatedEpochs).toBe(false)
    expect(r.transitions).toHaveLength(3)
    expect(r.fallback).toBe('deep')
  })

  it('loads a preset into the draft and discards back to the saved rules', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('Start from preset'), { target: { value: 'movementOnly' } })
    expect(screen.queryByLabelText('Rule 2 stage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Rule 2 stage')).toBeTruthy()
  })

  it('blocks saving an invalid ruleset', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('HRV (ms) minimum'), { target: { value: '400' } })
    expect(screen.getByText('min must be less than or equal to max')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('resets custom rules to the defaults with a null classifier', () => {
    trpcMock.state.classifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }
    trpcMock.state.isDefault = false
    renderRules()
    expect(screen.getByText('Using custom rules')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/ }))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({ side: 'left', classifier: null })
  })

  it('previews the draft after a pause and shows agreement with the watch', () => {
    trpcMock.state.preview = {
      sleepRecordId: 1,
      enteredBedAt: Date.UTC(2026, 9, 10, 23),
      leftBedAt: Date.UTC(2026, 9, 11, 7),
      hasReference: true,
      saved: { blocks: [], distribution: { wake: 5, light: 60, deep: 20, rem: 15 }, qualityScore: 70, totalSleepMs: 1, agreement: { epochs: 90, accuracy: 0.61, kappa: 0.42 } },
      candidate: { blocks: [], distribution: { wake: 5, light: 50, deep: 25, rem: 20 }, qualityScore: 80, totalSleepMs: 1, agreement: { epochs: 90, accuracy: 0.7, kappa: null } },
    }
    renderRules()
    expect(trpcMock.previewMutate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(400))
    expect(trpcMock.previewMutate).toHaveBeenCalledWith({ side: 'left', classifier: { engine: 'rules', ruleset: DEFAULT_STAGE_RULESET } })
    expect(screen.getByText('Watch 61% · κ 0.42')).toBeTruthy()
    expect(screen.getByText('Watch 70%')).toBeTruthy()
    expect(screen.getByText('Wake 5% · REM 20% · Light 50% · Deep 25%')).toBeTruthy()
  })

  it('does not preview an invalid draft', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('HRV (ms) minimum'), { target: { value: '400' } })
    act(() => vi.advanceTimersByTime(1000))
    expect(trpcMock.previewMutate).not.toHaveBeenCalled()
  })
})

it('shows pending rules separately from the acknowledged view', () => {
  trpcMock.state.pending = { classifier: { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }, generation: 7, warning: null }
  renderRules()
  expect(screen.getByRole('status').textContent).toContain('waiting for processor adoption')
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
})
