import { configHash } from '../../algorithms/canonical'
// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installedPromotionPolicies, unqualifiedPolicies } from '../qualification-registry'
import { evaluationFixture } from './fixtures/evaluation'
import { manifestHash } from '../../algorithms/registry'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'promotion-registry-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const fixture = () => {
  const work = evaluationFixture()
  const entry = { qualificationId: work.designations.stages.qualificationId, manifestHash, evaluatorBuildHash: work.job.evaluatorBuildHash,
    protocol: work.job.protocol, fixtureEvidenceHash: 'a'.repeat(64), podEvidenceHash: 'b'.repeat(64), waveformContext: null }
  return { entry, identity: { evaluatorBuildHash: entry.evaluatorBuildHash, protocolHash: work.job.protocolHash } }
}
const install = (entries: unknown[]) => writeFile(join(root, 'promotion-qualifications.json'), JSON.stringify({ version: 'biometric-promotion-qualifications-v1', entries }))
it('requires a unique installed build/protocol qualification and returns its policies', async () => {
  const { entry, identity } = fixture()
  const path = join(root, 'worker.cjs')
  expect(await installedPromotionPolicies(path, identity)).toEqual(unqualifiedPolicies())
  await install([entry])
  expect(await installedPromotionPolicies(path, identity)).toEqual({ protocolHash: identity.protocolHash, numeric: [], stages: entry.protocol.stageObjectivePolicy, waveformContext: null })
  for (const changed of [{ evaluatorBuildHash: 'f'.repeat(63) + '0' }, { protocolHash: 'c'.repeat(64) }, { pythonBuildHash: 'd'.repeat(64) }]) {
    expect(await installedPromotionPolicies(path, { ...identity, ...changed })).toEqual(unqualifiedPolicies())
  }
  await install([entry, entry])
  expect(await installedPromotionPolicies(path, identity)).toEqual(unqualifiedPolicies())
})
it('does not use malformed, cross-manifest, inconsistent or unbounded qualification files', async () => {
  const { entry, identity } = fixture()
  const path = join(root, 'worker.cjs')
  for (const changed of [{ ...entry, manifestHash: '0'.repeat(64) }, { ...entry, qualificationId: 'unrelated' },
    { ...entry, podEvidenceHash: undefined }, { ...entry, waveformContext: { allowedLimitations: [] } }]) {
    await install([changed])
    expect(await installedPromotionPolicies(path, identity)).toEqual(unqualifiedPolicies())
  }
  for (const data of ['{', ' '.repeat(256 * 1024 + 1)]) {
    await writeFile(join(root, 'promotion-qualifications.json'), data)
    expect(await installedPromotionPolicies(path, identity)).toEqual(unqualifiedPolicies())
  }
})

it('requires waveform context qualification and the exact Python build for waveform policies', async () => {
  const { entry } = fixture()
  const protocol = { ...entry.protocol, mode: 'signal_replay' as const, waveformStages: true }
  const pythonBuildHash = 'c'.repeat(64)
  const identity = { evaluatorBuildHash: entry.evaluatorBuildHash, pythonBuildHash, protocolHash: configHash(protocol) }
  const qualified = { ...entry, protocol, pythonBuildHash, waveformContext: { allowedLimitations: ['cold_start_without_serialized_state'] } }
  await install([qualified])
  expect(await installedPromotionPolicies(join(root, 'worker.cjs'), identity)).toMatchObject({
    protocolHash: identity.protocolHash, waveformContext: qualified.waveformContext,
  })
  await install([{ ...qualified, waveformContext: null }])
  expect(await installedPromotionPolicies(join(root, 'worker.cjs'), identity)).toEqual(unqualifiedPolicies())
})
