// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { monitorProcessGroupMemory, sampleProcessGroupRss } from '../process-group-memory'
let root: string | undefined
afterEach(async () => {
  vi.useRealTimers()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})
async function processFixture(pid: number, group: number, rss: string | null, state = 'S') {
  if (!root) root = await mkdtemp(join(tmpdir(), 'replay-proc-'))
  const directory = join(root, String(pid))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'stat'), `${pid} (name with ) parentheses) ${state} 1 ${group} 0 0\n`)
  if (rss !== null) await writeFile(join(directory, 'status'), rss)
  return directory
}
it('sums only the owned process group and treats disappearing members as an observation race', async () => {
  await processFixture(10, 10, 'VmRSS:\t100 kB\n')
  await processFixture(11, 10, 'VmRSS:\t200 kB\n')
  await processFixture(12, 12, 'VmRSS:\t999 kB\n')
  await processFixture(13, 10, null)
  await processFixture(14, 10, 'Name: zombie\n', 'Z')
  expect(await sampleProcessGroupRss(10, root)).toBe(300 * 1024)
  expect(await sampleProcessGroupRss(99, root)).toBeNull()
})
it('reports unavailable memory for malformed owned RSS and excessive group size', async () => {
  const directory = await processFixture(10, 10, 'VmRSS: unknown\n')
  expect(await sampleProcessGroupRss(10, root)).toBeNull()
  await writeFile(join(directory, 'status'), 'VmRSS: 99999999999999999999999 kB\n')
  expect(await sampleProcessGroupRss(10, root)).toBeNull()
  for (let pid = 10; pid < 75; pid++) await processFixture(pid, 10, 'VmRSS: 1 kB\n')
  expect(await sampleProcessGroupRss(10, root)).toBeNull()
})
it('retains sampled peaks, missing samples and gaps and stops its periodic work', async () => {
  vi.useFakeTimers()
  let time = 0
  const read = vi.fn().mockResolvedValueOnce(100).mockResolvedValueOnce(null).mockResolvedValue(300)
  const monitor = monitorProcessGroupMemory(1, { sample: read, now: () => time })
  await monitor.sample()
  time = 2000
  await monitor.sample()
  time = 2200
  await monitor.sample()
  expect(monitor.snapshot()).toMatchObject({ attempts: 3, samples: 2, allSamplesAvailable: false,
    peakObservedRssBytes: 300, maximumObservationGapMs: 2000, exactKernelPeak: false })
  await monitor.stop()
  await vi.advanceTimersByTimeAsync(5000)
  await monitor.sample()
  expect(read).toHaveBeenCalledTimes(3)
})
it('serializes slow reads and waits for them when stopped', async () => {
  let resolve: (value: number) => void = () => {}
  const read = vi.fn(() => new Promise<number>((done) => {
    resolve = done
  }))
  const monitor = monitorProcessGroupMemory(1, { sample: read })
  const first = monitor.sample(), second = monitor.sample()
  await Promise.resolve()
  expect(read).toHaveBeenCalledTimes(1)
  let stopped = false
  const stopping = monitor.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  resolve(500)
  await Promise.all([first, second, stopping])
  expect(stopped).toBe(true)
  expect(monitor.snapshot().peakObservedRssBytes).toBe(500)
})
