// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { configHash } from '../../algorithms/canonical'
import { probeShadowBuild } from '../build'
const location = { pythonPath: resolve('modules/piezo-processor/.venv/bin/python'), modulesPath: resolve('modules') }
it('probes the exact locked interpreter and requires shadow sources and intact identity', async () => {
  const build = await probeShadowBuild(location)
  expect(build).toEqual(await probeShadowBuild(location))
  expect(build.identity.version).toBe('shadow-python-build-v1')
  expect(build.identity.sources).toHaveProperty('common/biometrics/shadow_process.py')
  expect(build.identity.sources).toHaveProperty('common/biometrics/signal.py')
  const directory = await mkdtemp(join(tmpdir(), 'shadow-build-'))
  try {
    const executable = join(directory, 'probe')
    for (const raw of [{ ...build, hash: '0'.repeat(64) }, { ...build, identity: { ...build.identity, version: 'waveform-python-build-v1' } }]) {
      await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(raw))});`, { mode: 0o700 })
      await expect(probeShadowBuild({ ...location, pythonPath: executable })).rejects.toThrow()
    }
    const missing = structuredClone(build.identity)
    delete missing.sources['common/biometrics/shadow_process.py']
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ hash: configHash(missing), identity: missing }))});`, { mode: 0o700 })
    await expect(probeShadowBuild({ ...location, pythonPath: executable })).rejects.toThrow(/incomplete/)
    await expect(probeShadowBuild({ ...location, pythonPath: join(directory, 'missing') })).rejects.toThrow(/unavailable/)
    const abort = new AbortController()
    abort.abort()
    await expect(probeShadowBuild(location, abort.signal)).rejects.toThrow(/unavailable/)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
