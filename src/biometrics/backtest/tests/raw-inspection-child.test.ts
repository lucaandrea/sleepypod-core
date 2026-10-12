// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runRawInspectionChild } from '../raw-inspection-child'
let directory: string, executable: string
const input = { afterName: null }
const location = () => ({ pythonPath: executable, modulesPath: directory, archiveDirectory: directory })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inspection-child-'))
  executable = join(directory, 'worker')
})
afterEach(() => rm(directory, { recursive: true, force: true }))
async function worker(body: string) {
  await writeFile(executable, `#!${process.execPath}\nsetTimeout(() => process.exit(91), 3000).unref(); let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{${body}});`, { mode: 0o700 })
}
const emit = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`
it('uses the fixed module and clean environment and sends only a validated cursor', async () => {
  await worker(`if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(['-B', '-m', 'common.biometrics.inspection_worker', '--archive-directory', directory]))} || process.env.RAW_TEST_SECRET || process.env.PYTHONPATH!==${JSON.stringify(directory)} || input!==${JSON.stringify(JSON.stringify({ version: 'raw-inspection-work-v1', after_name: null }))})process.exit(1);${emit({ status: 'complete', nextCursor: null })}`)
  process.env.RAW_TEST_SECRET = 'private'
  try {
    expect(await runRawInspectionChild(location(), input)).toEqual({ status: 'complete', nextCursor: null })
  }
  finally { delete process.env.RAW_TEST_SECRET }
  expect(() => runRawInspectionChild(location(), { afterName: '../a.RAW.gz' })).toThrow()
  expect(() => runRawInspectionChild(location(), input, { timeoutMs: 120001 })).toThrow('time budget')
})
it.each([
  '{', '{}', '{"status":"complete","nextCursor":null}\n{}',
  '{"status":"source_unavailable","nextCursor":"../a.RAW.gz"}',
  '{"status":"complete","nextCursor":null,"extra":true}',
])('rejects malformed or additional output %s', async (output) => {
  await worker(`process.stdout.write(${JSON.stringify(output)});`)
  await expect(runRawInspectionChild(location(), input)).rejects.toThrow('invalid or incomplete')
})
it('requires advancing cursors, valid UTF-8 and successful exit', async () => {
  await worker(emit({ status: 'source_unavailable', nextCursor: 'a.RAW.gz' }))
  await expect(runRawInspectionChild(location(), { afterName: 'a.RAW.gz' })).rejects.toThrow('invalid or incomplete')
  await worker(`${emit({ status: 'complete', nextCursor: null })}process.stdout.write(Buffer.from([0xc3]));`)
  await expect(runRawInspectionChild(location(), input)).rejects.toThrow('invalid or incomplete')
  await worker(`${emit({ status: 'complete', nextCursor: null })}process.exitCode=1;`)
  await expect(runRawInspectionChild(location(), input)).rejects.toThrow('invalid or incomplete')
})
it('bounds output, diagnostics, elapsed time and cancellation', async () => {
  await worker('process.stdout.write(\'x\'.repeat(65537));')
  await expect(runRawInspectionChild(location(), input)).rejects.toThrow('output exceeded')
  await worker('process.stderr.write(\'x\'.repeat(16385));')
  await expect(runRawInspectionChild(location(), input)).rejects.toThrow('diagnostics exceeded')
  await worker('setInterval(()=>{},1000);')
  await expect(runRawInspectionChild(location(), input, { timeoutMs: 30 })).rejects.toThrow('time budget')
  const controller = new AbortController()
  const running = runRawInspectionChild(location(), input, { signal: controller.signal })
  controller.abort()
  await expect(running).rejects.toThrow('cancelled')
  await expect(runRawInspectionChild(location(), input, { signal: controller.signal })).rejects.toThrow('cancelled')
  await expect(runRawInspectionChild({ ...location(), pythonPath: join(directory, 'missing') }, input)).rejects.toThrow('could not start')
})
