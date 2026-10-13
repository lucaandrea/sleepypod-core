// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runRawCollectionChild } from '../raw-collection-child'
let directory: string, executable: string
const location = () => ({ pythonPath: executable, modulesPath: directory, databasePath: join(directory, 'db'), retainedDirectory: join(directory, 'raw') })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'collection-child-'))
  executable = join(directory, 'worker')
})
afterEach(() => rm(directory, { recursive: true, force: true }))
async function worker(body: string) {
  await writeFile(executable, `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{${body}});`, { mode: 0o700 })
}
const result = { version: 'raw-collection-result-v1', released: 2, orphans: 1 }
const emit = `process.stdout.write(${JSON.stringify(JSON.stringify(result))});`
it('uses fixed module, trusted paths and an input with no caller-controlled retention settings', async () => {
  const args = ['-B', '-m', 'common.biometrics.collection_worker', '--database-path', location().databasePath, '--retained-directory', location().retainedDirectory]
  await worker(`if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(args))} || input!==${JSON.stringify(JSON.stringify({ version: 'raw-collection-work-v1' }))})process.exit(1);${emit}`)
  expect(await runRawCollectionChild(location())).toEqual(result)
})
it('rejects malformed output and unsuccessful exit', async () => {
  await worker('process.stdout.write("{}");')
  await expect(runRawCollectionChild(location())).rejects.toThrow('invalid or incomplete')
  await worker(`${emit}process.exitCode=1;`)
  await expect(runRawCollectionChild(location())).rejects.toThrow('invalid or incomplete')
})
it('bounds output, diagnostics and time, and cancels a running child', async () => {
  await worker('process.stdout.write("x".repeat(1025));')
  await expect(runRawCollectionChild(location())).rejects.toThrow('output exceeded')
  await worker('process.stderr.write("x".repeat(16385));')
  await expect(runRawCollectionChild(location())).rejects.toThrow('diagnostics exceeded')
  await worker('setInterval(()=>{},1000);')
  await expect(runRawCollectionChild(location(), { timeoutMs: 50 })).rejects.toThrow('time budget')
  const controller = new AbortController()
  const promise = runRawCollectionChild(location(), { signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await expect(promise).rejects.toThrow('cancelled')
})
