import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessGroupMemory } from './process-group-memory-contract'

/** Fixed procfs reads only; never inspect argv, environment, or other exports.
 * Shared pages may be counted in more than one process's RSS. */
export async function sampleProcessGroupRss(group: number, root = '/proc'): Promise<number | null> {
  if (!Number.isSafeInteger(group) || group < 1) return null
  try {
    const pids = (await readdir(/* turbopackIgnore: true */ root)).filter(name => /^[1-9]\d*$/.test(name))
    if (pids.length > 4096) return null
    let total = 0, members = 0
    for (let i = 0; i < pids.length; i += 16) {
      const values = await Promise.all(pids.slice(i, i + 16).map(async (pid) => {
        try {
          const stat = await readFile(join(root, pid, 'stat'), 'utf8')
          if (stat.length > 16384) throw new Error('Invalid proc stat')
          const end = stat.lastIndexOf(')')
          if (end < 0) throw new Error('Invalid proc stat')
          const fields = stat.slice(end + 1).trim().split(/\s+/)
          if (!/^\d+$/.test(fields[2] ?? '')) throw new Error('Missing process group')
          if (Number(fields[2]) !== group) return 0
          const status = await readFile(join(root, pid, 'status'), 'utf8')
          if (status.length > 16384) throw new Error('Invalid proc status')
          const rss = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(status)
          // Zombies have no address space and no VmRSS entry.
          if (!rss && fields[0] === 'Z') return 0
          if (!rss) throw new Error('Missing process RSS')
          members++
          const bytes = Number(rss[1]) * 1024
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid process RSS')
          return bytes
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return 0
          throw error
        }
      }))
      total += values.reduce((sum, value) => sum + value, 0)
      if (members > 64 || !Number.isSafeInteger(total)) return null
    }
    return members > 0 && total > 0 ? total : null
  }
  catch { return null }
}

export function monitorProcessGroupMemory(group: number, options: { sample?: () => Promise<number | null>, now?: () => number } = {}) {
  const now = options.now ?? (() => performance.now())
  const read = options.sample ?? (() => process.platform === 'linux' ? sampleProcessGroupRss(group) : Promise.resolve(null))
  const started = now()
  let last = started, gap = 0, attempts = 0, samples = 0, peak = 0, stopped = false
  let active: Promise<void> | null = null
  const sample = () => {
    if (stopped) return Promise.resolve()
    active ??= Promise.resolve().then(read).catch(() => null).then((rss) => {
      const at = now()
      gap = Math.max(gap, at - last)
      last = at
      attempts++
      if (rss !== null && Number.isSafeInteger(rss) && rss > 0) {
        samples++
        peak = Math.max(peak, rss)
      }
    }).finally(() => { active = null })
    return active
  }
  const timer = setInterval(() => {
    void sample()
  }, 1000)
  timer.unref()
  void sample()
  return { sample,
    snapshot: (): ProcessGroupMemory => ({ version: 'process-group-rss-observations-v1', scope: 'sum_rss_of_replay_process_group',
      attempts, samples, allSamplesAvailable: samples > 0 && samples === attempts, peakObservedRssBytes: samples ? peak : null,
      maximumObservationGapMs: Math.max(gap, now() - last), intervalMs: 1000, exactKernelPeak: false }),
    async stop() {
      stopped = true
      clearInterval(timer)
      await active
    },
  }
}
