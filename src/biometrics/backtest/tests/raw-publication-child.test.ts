// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runRawPublicationChild } from '../raw-publication-child'
let directory: string, executable: string
const hash = 'a'.repeat(64)
// This protocol fixture never runs Python or publishes rows.
const work = { prepared: { contentHash: hash }, selections: [] } as unknown as Parameters<typeof runRawPublicationChild>[1]
const result = { type: 'result', id: '11111111-1111-4111-8111-111111111111', contentHash: hash, available: true }
const location = () => ({ pythonPath: executable, modulesPath: directory, archiveDirectory: directory, retainedDirectory: join(directory, 'raw'), databasePath: join(directory, 'test.db') })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'publication-child-'))
  executable = join(directory, 'worker')
})
afterEach(() => rm(directory, { recursive: true, force: true }))
async function worker(body: string) {
  await writeFile(executable, `#!${process.execPath}\nsetTimeout(() => process.exit(91), 3000).unref(); let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{${body}});`, { mode: 0o700 })
}
const emit = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`
it('uses fixed publication arguments, a clean environment and the versioned envelope', async () => {
  await worker(`if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(['-B', '-m', 'common.biometrics.publication_worker', '--database', location().databasePath, '--archive-directory', directory, '--retained-directory', location().retainedDirectory]))} || process.env.RAW_TEST_SECRET || process.env.PYTHONPATH!==${JSON.stringify(directory)} || input!==${JSON.stringify(JSON.stringify({ version: 'waveform-publication-work-v1', ...work }))})process.exit(1);${emit(result)}`)
  process.env.RAW_TEST_SECRET = 'private'
  try {
    expect(await runRawPublicationChild(location(), work)).toEqual(result)
  }
  finally { delete process.env.RAW_TEST_SECRET }
  expect(() => runRawPublicationChild(location(), work, { timeoutMs: 120001 })).toThrow('time budget')
})
it.each([
  {}, { ...result, contentHash: 'b'.repeat(64) }, { ...result, id: 'bad' }, { ...result, extra: true },
])('rejects invalid identities or unexpected fields %#', async (output) => {
  await worker(emit(output))
  await expect(runRawPublicationChild(location(), work)).rejects.toThrow('invalid or incomplete')
})
it('rejects extra output, invalid UTF-8 and unsuccessful exit after a response', async () => {
  for (const suffix of ['process.stdout.write("{}");', 'process.stdout.write(Buffer.from([0xc3]));', 'process.exitCode=1;']) {
    await worker(`${emit(result)}${suffix}`)
    await expect(runRawPublicationChild(location(), work)).rejects.toThrow('invalid or incomplete')
  }
})
it('bounds input, output, diagnostics and execution, and cancels work', async () => {
  await expect(runRawPublicationChild(location(), { ...work, padding: 'x'.repeat(10 * 1024 * 1024) } as typeof work)).rejects.toThrow('input exceeds')
  await worker('process.stdout.write("x".repeat(65537));')
  await expect(runRawPublicationChild(location(), work)).rejects.toThrow('output exceeded')
  await worker('process.stderr.write("x".repeat(16385));')
  await expect(runRawPublicationChild(location(), work)).rejects.toThrow('diagnostics exceeded')
  await worker('setInterval(()=>{},1000);')
  await expect(runRawPublicationChild(location(), work, { timeoutMs: 30 })).rejects.toThrow('time budget')
  const controller = new AbortController()
  const running = runRawPublicationChild(location(), work, { signal: controller.signal })
  controller.abort()
  await expect(running).rejects.toThrow('cancelled')
  await expect(runRawPublicationChild(location(), work, { signal: controller.signal })).rejects.toThrow('cancelled')
  await expect(runRawPublicationChild({ ...location(), pythonPath: join(directory, 'missing') }, work)).rejects.toThrow('could not start')
})
