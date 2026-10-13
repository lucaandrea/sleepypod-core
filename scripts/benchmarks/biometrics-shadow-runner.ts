/** Synthetic-only target-pod shadow supervisor measurement. Bundle with esbuild.
 * Arguments: OUTPUT_JSON PYTHON_PATH MODULES_PATH [SECONDS=1800]
 * Uses no live inputs, databases, admission registry or hardware interfaces.
 * Run alone: the shipped child requires the shared kernel replay/shadow slot.
 */
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { defaultConfig, manifestHash } from '../../src/biometrics/algorithms/registry'
import { configHash } from '../../src/biometrics/algorithms/canonical'
import { runShadowChild } from '../../src/biometrics/shadow/worker-child'
import { probeShadowBuild } from '../../src/biometrics/shadow/build'
import type { ShadowPartialReceipt } from '../../src/biometrics/shadow/receipt'

async function main() {
  const [output, pythonPath, modulesPath, duration = '1800'] = process.argv.slice(2)
  const seconds = Number(duration)
  if (!output || !pythonPath || !modulesPath || !Number.isInteger(seconds) || seconds < 150 || seconds > 28800) {
    throw new Error('Expected OUTPUT_JSON PYTHON_PATH MODULES_PATH and 150–28800 synthetic seconds')
  }
  const pythonBuild = await probeShadowBuild({ pythonPath, modulesPath })
  const runnerHash = createHash('sha256').update(await readFile(process.argv[1])).digest('hex')
  const startMs = 1700000000000, hash = configHash(defaultConfig)
  // Measurement stop conditions, not deployment qualification or recommended limits.
  const budgets = { cpuSeconds: 1200, addressSpaceBytes: 768 * 1024 * 1024, maximumRssBytes: 384 * 1024 * 1024,
    wallMs: 1800000, acknowledgmentMs: 30000, idleMs: 30000, rssIntervalMs: 100, rssTimeoutMs: 1000 }
  const init = { schema: 'biometric-shadow-worker-v1', runId: randomUUID(), attemptId: randomUUID(), side: 'left',
    startMs, endMs: startMs + seconds * 1000, configs: { left: defaultConfig, right: defaultConfig },
    configHashes: { left: hash, right: hash }, maximumRecords: seconds, maximumOutputs: seconds,
    maximumCpuMs: 1200000, maximumInputBytes: seconds * 6500 + 128 * 1024, maximumOutputBytes: seconds * 4096 }
  async function* frames() {
    for (let second = 0; second < seconds; second++) {
      const channel = Buffer.alloc(2000)
      for (let sample = 0; sample < 500; sample++) {
        const t = second + sample / 500
        channel.writeInt32LE(Math.trunc(1000000 * Math.sin(2 * Math.PI * 1.2 * t)), sample * 4)
      }
      yield { type: 'frame', sequence: second, observedAtMs: startMs + second * 1000,
        record: { type: 'piezo-dual', left1: channel.toString('base64'), right1: Buffer.alloc(2000).toString('base64') },
        context: { activeSides: ['left'], leftOccupied: true, rightOccupied: false, pumpContextKnown: true } }
    }
  }
  const histogram = monitorEventLoopDelay({ resolution: 20 }), digest = createHash('sha256')
  let outputCount = 0, partial: ShadowPartialReceipt | null = null, receipt: unknown = null, failure: string | null = null
  histogram.enable()
  const began = performance.now()
  try {
    receipt = await runShadowChild({ pythonPath, modulesPath }, init, frames(), (row) => {
      outputCount++
      digest.update(JSON.stringify(row)).update('\n')
    }, { budgets, onResources: (value) => { partial = value } })
  }
  catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  }
  finally {
    histogram.disable()
    await writeFile(output, JSON.stringify({ version: 'synthetic-shadow-supervisor-measurement-v1',
      scope: 'accelerated synthetic frames through shipped supervisor and kernel-limited child; no live capture, database sink, held-out accuracy or installation qualification',
      runnerHash, pythonBuildHash: pythonBuild.hash, pythonBuildIdentity: pythonBuild.identity,
      node: { version: process.version, platform: process.platform, arch: process.arch },
      manifestHash, configHash: hash, seconds, sampleRateHz: 500, channels: 2, wallMs: performance.now() - began,
      outputCount, outputHash: digest.digest('hex'), receipt, partial, failure,
      parentEventLoopP95Ms: histogram.percentile(95) / 1e6, parentEventLoopMaxMs: histogram.max / 1e6,
      parentPeakRssKiB: process.resourceUsage().maxRSS }, null, 2))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
