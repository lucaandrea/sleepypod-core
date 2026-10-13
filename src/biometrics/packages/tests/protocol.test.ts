import { describe, expect, it } from 'vitest'
import { canonicalJson, configHash, dataHash } from '../../algorithms/canonical'
import { PackageFrameValidator } from '../protocol'
import { packageFixture } from './fixture'

function fixture() {
  const { manifest } = packageFixture()
  const request = { schema: 'biometric-package-run-v1', packageHash: configHash(manifest), inputHash: 'a'.repeat(64), hardwareId: 'pod4', sampleRateHz: 500, side: 'left', seed: 123, config: {} }
  const frame = { schema: 'biometric-signal-frame-v1', sequence: 0, timestampMs: 1000, samples: { left: [1, 2, 3], right: null }, context: { occupied: null, pumpActive: null } }
  const validator = new PackageFrameValidator(manifest, request)
  const result = { schema: 'biometric-metric-frame-v1', runHash: validator.runHash, frameHash: dataHash(frame), sequence: 0,
    readings: [{ timestampMs: 1004, side: 'left', metric: 'heart_rate', value: 60, quality: 0.9, flags: [] }], state: { count: 3 } }
  return { manifest, request, frame, result, validator }
}

describe('algorithm frame exchange', () => {
  it('accepts deterministic identities and ordered frames with explicit unknown context', () => {
    const { frame, result, validator } = fixture()
    expect(validator.validateStep(frame, result).endMs).toBe(1006)
    const next = { ...frame, sequence: 1, timestampMs: 1006 }
    expect(validator.validateStep(next, { ...result, frameHash: dataHash(next), sequence: 1, readings: [] }).endMs).toBe(1012)
  })
  it('binds the run to package, input, configuration and deterministic seed', () => {
    const { manifest, request, validator } = fixture()
    for (const changed of [{ ...request, seed: 124 }, { ...request, config: { threshold: 10 } }, { ...request, inputHash: 'b'.repeat(64) }]) {
      expect(new PackageFrameValidator(manifest, changed).runHash).not.toBe(validator.runHash)
    }
    for (const changed of [{ ...request, packageHash: 'b'.repeat(64) }, { ...request, hardwareId: 'other' }, { ...request, sampleRateHz: 100 }]) {
      expect(() => new PackageFrameValidator(manifest, changed)).toThrow()
    }
  })
  it('rejects output substitution and leaves the run retryable', () => {
    const { frame, result, validator } = fixture()
    for (const changed of [{ ...result, runHash: 'b'.repeat(64) }, { ...result, frameHash: 'b'.repeat(64) }, { ...result, sequence: 1 }]) {
      expect(() => validator.validateStep(frame, changed)).toThrow('identity')
    }
    expect(validator.validateStep(frame, result).endMs).toBe(1006)
  })
  it('rejects future, undeclared, out-of-range and duplicated readings', () => {
    const { frame, result } = fixture()
    const reading = result.readings[0]
    for (const readings of [[{ ...reading, timestampMs: 1006 }], [{ ...reading, timestampMs: 999 }], [{ ...reading, side: 'right' }],
      [{ ...reading, metric: 'hrv' }], [{ ...reading, value: 300 }], [reading, reading]]) {
      expect(() => fixture().validator.validateStep(frame, { ...result, readings })).toThrow()
    }
  })
  it('rejects overlapping frames, missing channels and inconsistent channel lengths', () => {
    const { frame, result, validator } = fixture()
    for (const changed of [{ ...frame, sequence: 1 }, { ...frame, samples: { left: null, right: [1] } }, { ...frame, samples: { left: [1], right: [1, 2] } }]) {
      expect(() => validator.validateStep(changed, result)).toThrow()
    }
    validator.validateStep(frame, result)
    expect(() => validator.validateStep({ ...frame, sequence: 1, timestampMs: 1005 }, result)).toThrow('overlapping')
    const next = { ...frame, sequence: 1, timestampMs: 1006 }
    expect(() => validator.validateStep(next, { ...result, sequence: 1, frameHash: dataHash(next) })).toThrow('Duplicate')
  })
  it('enforces declared lookahead without accepting future readings', () => {
    const { manifest, request, frame, result } = fixture()
    const retrospective = { ...manifest, temporal: { mode: 'retrospective', lookaheadMs: 4 } }
    const validator = new PackageFrameValidator(retrospective, { ...request, packageHash: configHash(retrospective) })
    const output = { ...result, runHash: validator.runHash }
    expect(() => validator.validateStep(frame, output)).toThrow('time range')
    expect(validator.validateStep(frame, { ...output, readings: [{ ...output.readings[0], timestampMs: 1000 }] })).toBeDefined()
  })
  it('enforces the cumulative output budget across individually small responses', () => {
    const { manifest, request, frame, result } = fixture()
    manifest.resources.outputBytes = Buffer.byteLength(canonicalJson(result)) + 10
    const validator = new PackageFrameValidator(manifest, { ...request, packageHash: configHash(manifest) })
    validator.validateStep(frame, { ...result, runHash: validator.runHash })
    const next = { ...frame, sequence: 1, timestampMs: 1006 }
    expect(() => validator.validateStep(next, { ...result, runHash: validator.runHash, frameHash: dataHash(next), sequence: 1, readings: [] })).toThrow('Output byte limit')
  })
  it('bounds state and response sizes and rejects non-JSON state', () => {
    for (const kind of ['state', 'output', 'non-json']) {
      const { manifest, request, frame, result } = fixture()
      if (kind === 'state') manifest.state.maximumBytes = 2
      if (kind === 'output') manifest.resources.outputBytes = 2
      const validator = new PackageFrameValidator(manifest, { ...request, packageHash: configHash(manifest) })
      expect(() => validator.validateStep(frame, { ...result, runHash: validator.runHash, state: kind === 'non-json' ? new Date() : result.state })).toThrow()
    }
  })
})
