// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packageFixture } from '../../src/biometrics/packages/tests/fixture'
import { publishJson, readJsonFile, readJsonLines, readPackageProposal } from './files'
import { runExperimentCli } from './cli'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'package-files-test-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function proposal() {
  const { files, manifest } = packageFixture()
  return { schema: 'biometric-package-proposal-v1', manifest, files: [...files].map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })) }
}
describe('experiment CLI file boundary', () => {
  it('inspects an inert proposal and creates a complete private report without running its code', async () => {
    const path = join(root, 'proposal.json'), report = join(root, 'report.json')
    await writeFile(path, JSON.stringify(proposal()))
    await runExperimentCli(['inspect', path, report])
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({ status: 'inert_proposal', manifest: { engine: { id: 'test.hr' } } })
    expect((await stat(report)).mode & 0o777).toBe(0o600)
    await expect(publishJson(report, { replaced: true })).rejects.toThrow()
    expect(await readdir(root)).toEqual(['proposal.json', 'report.json'])
  })
  it('rejects changed bytes, duplicate files and noncanonical base64', async () => {
    const original = proposal()
    for (const changed of [{ ...original, files: [original.files[0], original.files[0]] },
      { ...original, files: [{ ...original.files[0], base64: 'cGFzcw==' }, original.files[1]] },
      { ...original, files: [{ ...original.files[0], base64: original.files[0].base64 + '\n' }, original.files[1]] }]) {
      const path = join(root, 'proposal.json')
      await writeFile(path, JSON.stringify(changed))
      expect(() => readPackageProposal(path)).toThrow()
    }
  })
  it('rejects symlinks, nonfiles and byte limits for JSON and JSONL', async () => {
    const path = join(root, 'input'), link = join(root, 'symlink')
    await writeFile(path, '{"value":1}\n{"value":2}\n')
    await symlink(path, link)
    expect([...readJsonLines(path, 100)]).toEqual([{ value: 1 }, { value: 2 }])
    for (const invalid of [root, link]) {
      expect(() => readJsonFile(invalid, 100)).toThrow()
      expect(() => [...readJsonLines(invalid, 100)]).toThrow()
    }
    expect(() => [...readJsonLines(path, 5)]).toThrow()
    expect(() => [...readJsonLines(path, 100, 2)]).toThrow('line byte limit')
    expect(() => readJsonFile(path, 5)).toThrow()
  })
  it('rejects malformed UTF-8, blank lines and incorrect CLI arguments', async () => {
    const path = join(root, 'input')
    await writeFile(path, Buffer.from([255]))
    expect(() => readJsonFile(path, 100)).toThrow()
    expect(() => [...readJsonLines(path, 100)]).toThrow()
    await writeFile(path, '\n')
    expect(() => [...readJsonLines(path, 100)]).toThrow('Empty JSON')
    await expect(runExperimentCli(['run'])).rejects.toThrow('Usage:')
  })
})
