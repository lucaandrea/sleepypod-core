// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { expiredOwnedContainer, recoveryLabels } from './recovery'

const now = 1000000
const id = 'a'.repeat(64)
const valid = (kind: 'experiment' | 'environment' = 'experiment') => ({ Id: id,
  Name: `/sleepypod-${kind}-12345678-1234-1234-1234-123456789abc`,
  Config: { Labels: recoveryLabels(kind, 1000, now) } })

describe('expired experiment recovery ownership', () => {
  it('preserves live controllers through their deadline and cleanup grace', () => {
    expect(expiredOwnedContainer(valid(), now + 120999)).toBeNull()
    expect(expiredOwnedContainer(valid(), now + 121000)).toBe(id)
    expect(expiredOwnedContainer(valid('environment'), now + 121000)).toBe(id)
  })
  it('requires exact version, host owner, kind and immutable full ID', () => {
    const container = valid()
    for (const [field, value] of [['version', '2'], ['owner', 'foreign'], ['kind', 'environment'], ['expires', 'NaN'], ['expires', '0'], ['expires', '9999999999999999']]) {
      expect(expiredOwnedContainer({ ...container, Config: { Labels: { ...container.Config.Labels,
        [`org.sleepypod.experiment.${field}`]: value } } }, now + 121000)).toBeNull()
    }
    for (const value of [null, {}, { ...container, Id: 'short' }, { ...container, Name: '/unrelated' },
      { ...container, Config: {} }, { ...container, Name: '/sleepypod-experiment-not-a-uuid' }]) {
      expect(expiredOwnedContainer(value, now + 121000)).toBeNull()
    }
  })
  it('rejects invalid clock and budget inputs', () => {
    for (const value of [-1, 0, NaN, Infinity, 3600001]) expect(() => recoveryLabels('experiment', value)).toThrow()
    expect(() => recoveryLabels('experiment', 1000, -1)).toThrow()
    expect(expiredOwnedContainer(valid(), NaN)).toBeNull()
  })
})

// Actual daemon test: an abandoned process remains alive until recovery, while
// an unexpired controller and an unlabelled lookalike survive the same sweep.
it.skipIf(!process.env.BIOMETRIC_EXPERIMENT_TEST_IMAGE)('removes an overdue running container and preserves other containers', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { randomUUID } = await import('node:crypto')
  const { recoverExpiredContainers } = await import('./recovery')
  const exec = promisify(execFile)
  const containers: string[] = []
  const clock = Date.now()
  const image = process.env.BIOMETRIC_EXPERIMENT_TEST_IMAGE
  if (!image) throw new Error('Test image required')
  try {
    for (const labels of [recoveryLabels('experiment', 1000, clock - 122000), recoveryLabels('experiment', 1000, clock), {}]) {
      const result = await exec('docker', ['run', '-d', '--name', `sleepypod-experiment-${randomUUID()}`,
        ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
        '--user', '65534:65534', '--pids-limit', '16', '--memory', '134217728', '--cpus', '1',
        '--entrypoint', 'python', image, '-I', '-B', '-c', 'import time; time.sleep(120)'],
      { timeout: 10000 })
      containers.push(result.stdout.trim())
    }
    const report = await recoverExpiredContainers(clock)
    expect(report.removed).toContain(containers[0])
    expect(report.removed).not.toContain(containers[1])
    expect(report.removed).not.toContain(containers[2])
    await expect(exec('docker', ['inspect', containers[0]])).rejects.toThrow()
    for (const container of containers.slice(1)) {
      expect((await exec('docker', ['inspect', '--format', '{{.State.Running}}', container])).stdout.trim()).toBe('true')
    }
    expect((await recoverExpiredContainers(clock)).removed).not.toContain(containers[0])
  }
  finally {
    for (const container of containers) await exec('docker', ['rm', '-f', container]).catch(() => undefined)
  }
}, 60000)
