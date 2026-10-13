// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { freezePackageInput, packageInputHash, readFrozenPackageInput } from './input'

const frame = { schema: 'biometric-signal-frame-v1', sequence: 0, timestampMs: 1000,
  samples: { left: [1, 2, 3], right: null }, context: { occupied: null, pumpActive: null } }

describe('frozen experiment input', () => {
  it('binds sample bytes, context, ordering and timestamps to a streamed identity', () => {
    const original = packageInputHash([frame])
    for (const changed of [{ ...frame, timestampMs: 1001 }, { ...frame, context: { occupied: true, pumpActive: null } },
      { ...frame, samples: { left: [1, 2, 4], right: null } }]) expect(packageInputHash([changed])).not.toBe(original)
    expect(packageInputHash([frame, { ...frame, sequence: 1 }])).not.toBe(packageInputHash([{ ...frame, sequence: 1 }, frame]))
    expect(packageInputHash([{ context: frame.context, samples: frame.samples, timestampMs: 1000, sequence: 0, schema: frame.schema }])).toBe(original)
  })
  it('reads the frozen copy after source mutation and enforces storage bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-input-test-'))
    try {
      const source = structuredClone(frame)
      const next = { ...frame, sequence: 1, timestampMs: 1006 }
      const frozen = await freezePackageInput(join(root, 'input'), [source, next], 10000)
      source.samples.left[0] = 999
      const collected = []
      for await (const value of readFrozenPackageInput(join(root, 'input'))) collected.push(value)
      expect(collected).toEqual([frame, next])
      expect(frozen).toMatchObject({ hash: packageInputHash([frame, next]), frameCount: 2 })
      await expect(freezePackageInput(join(root, 'input'), [frame], 10000)).rejects.toThrow()
      await expect(freezePackageInput(join(root, 'small'), [frame], 10)).rejects.toThrow('byte limit')
      await expect(freezePackageInput(join(root, 'empty'), [], 10000)).rejects.toThrow('at least one')
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
})
