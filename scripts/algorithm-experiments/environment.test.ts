// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { matchPythonEnvironment, parsePythonEnvironmentLock, pythonEnvironmentLockSchema } from './environment'
const image = 'sha256:' + 'a'.repeat(64)
const lock = { schema: 'biometric-python-environment-v1', image, implementation: 'cpython', pythonVersion: '3.12.13', system: 'Linux', machine: 'aarch64', distributions: [{ name: 'numpy', version: '2.0.0' }, { name: 'scipy', version: '1.0.0' }] }
const bytes = Buffer.from(JSON.stringify(lock))
describe('locked Python environment', () => {
  it('binds the image, interpreter, architecture and complete distribution inventory', () => {
    expect(matchPythonEnvironment(bytes, lock, image)).toMatchObject({ image, schema: 'biometric-python-environment-verification-v1' })
    for (const actual of [{ ...lock, image: 'sha256:' + 'b'.repeat(64) }, { ...lock, machine: 'x86_64' }, { ...lock, pythonVersion: '3.13.0' },
      { ...lock, distributions: lock.distributions.slice(0, 1) }, { ...lock, distributions: [{ name: 'numpy', version: '2.1.0' }, lock.distributions[1]] }]) {
      expect(() => matchPythonEnvironment(bytes, actual, image)).toThrow('differs')
    }
  })
  it('rejects ambiguous names, ordering, duplicates and extra lock fields', () => {
    for (const invalid of [{ ...lock, distributions: [...lock.distributions].reverse() }, { ...lock, distributions: [lock.distributions[0], lock.distributions[0]] },
      { ...lock, distributions: [{ name: 'Num_Py', version: '2.0.0' }] }, { ...lock, command: 'pip install latest' }]) {
      expect(pythonEnvironmentLockSchema.safeParse(invalid).success).toBe(false)
    }
  })
  it('rejects unpinned images, foreign image locks, invalid encoding and oversized locks', () => {
    expect(() => parsePythonEnvironmentLock(bytes, 'python:latest')).toThrow('operator image')
    expect(() => parsePythonEnvironmentLock(Buffer.alloc(256 * 1024 + 1), image)).toThrow('byte limit')
    expect(() => parsePythonEnvironmentLock(Buffer.from([255]), image)).toThrow()
  })
})
