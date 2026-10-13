import { packageFixture as fixture } from './fixture'
import { describe, expect, it } from 'vitest'
import { algorithmPackageManifestSchema, maximumPackageBytes, verifyAlgorithmPackage } from '../manifest'

describe('inert algorithm package intake', () => {
  it('verifies executable bytes without executing them and binds all declarations to the package identity', () => {
    const { files, manifest } = fixture()
    const original = verifyAlgorithmPackage(manifest, files)
    expect(original.status).toBe('inert_proposal')
    expect(verifyAlgorithmPackage(JSON.parse(JSON.stringify(manifest)), files).packageHash).toBe(original.packageHash)
    manifest.resources.cpuMs++
    expect(verifyAlgorithmPackage(manifest, files).packageHash).not.toBe(original.packageHash)
  })
  it('rejects substituted code and locks even when the file size is unchanged', () => {
    for (const path of ['engine.py', 'uv.lock']) {
      const { files, manifest } = fixture()
      const original = files.get(path)
      if (!original) throw new Error('Missing fixture file')
      files.set(path, Buffer.alloc(original.length, 65))
      expect(() => verifyAlgorithmPackage(manifest, files)).toThrow('hash mismatch')
    }
  })
  it('rejects missing, extra, truncated and oversized files', () => {
    const { files, manifest } = fixture()
    files.set('extra.py', Buffer.from('pass'))
    expect(() => verifyAlgorithmPackage(manifest, files)).toThrow('file set')
    files.delete('extra.py')
    files.set('engine.py', Buffer.from('pass'))
    expect(() => verifyAlgorithmPackage(manifest, files)).toThrow('size mismatch')
    files.delete('engine.py')
    expect(() => verifyAlgorithmPackage(manifest, files)).toThrow('file set')
    manifest.artifacts[0].bytes = maximumPackageBytes
    expect(() => verifyAlgorithmPackage(manifest, fixture().files)).toThrow('byte limit')
  })
  it.each(['../engine.py', '/engine.py', 'a/../../engine.py', 'a\\engine.py', 'a//engine.py', './engine.py', 'a/engine.py\u0000'])('rejects unsafe artifact path %s', (path) => {
    const { manifest } = fixture()
    manifest.artifacts[0].path = path
    manifest.entrypoint = path
    expect(algorithmPackageManifestSchema.safeParse(manifest).success).toBe(false)
  })
  it('requires canonical units and explicit HRV windows for comparable metrics', () => {
    const { manifest } = fixture()
    const metric = manifest.metrics[0]
    const parse = (unit: string, reference: unknown) => algorithmPackageManifestSchema.safeParse({ ...manifest, metrics: [{ ...metric, unit, reference }] }).success
    expect(parse('bpm', { metric: 'heart_rate', windowMs: null })).toBe(true)
    expect(parse('ms', { metric: 'hrv_rmssd', windowMs: 300000 })).toBe(true)
    expect(parse('bpm', { metric: 'hrv_rmssd', windowMs: 300000 })).toBe(false)
    expect(parse('ms', { metric: 'hrv_rmssd', windowMs: null })).toBe(false)
    expect(parse('ms', { metric: 'hrv_unknown', windowMs: 300000 })).toBe(false)
  })
  it('rejects ambiguous identity, unhashed entrypoints, missing locks and unknown privileges', () => {
    const { manifest } = fixture()
    for (const altered of [
      { ...manifest, metrics: [...manifest.metrics, manifest.metrics[0]] },
      { ...manifest, artifacts: [...manifest.artifacts, manifest.artifacts[0]] },
      { ...manifest, hardware: [...manifest.hardware, manifest.hardware[0]] },
      { ...manifest, hardware: [{ id: 'pod4', sampleRatesHz: [500, 500] }] },
      { ...manifest, entrypoint: 'other.py' }, { ...manifest, dependencyLock: 'absent.lock' },
      { ...manifest, dependencyLock: manifest.entrypoint }, { ...manifest, network: true },
      { ...manifest, resources: { ...manifest.resources, processes: 0 } },
      { ...manifest, temporal: { mode: 'causal', lookaheadMs: 1000 } },
    ]) expect(algorithmPackageManifestSchema.safeParse(altered).success).toBe(false)
  })
})
