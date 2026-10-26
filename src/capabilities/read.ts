import { readFile } from 'node:fs/promises'
import { getRoomContext } from '@/src/home-context/instance'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getBaseControllerIfRunning } from '@/src/hardware/base/instance'
import { getBridgeStatus } from '@/src/streaming/mqttBridge'
import { getComfortRuntimeIfRunning } from '@/src/comfort/instance'
import { buildCapabilities, DEVICE_FRESHNESS_MS } from './contract'

async function readRevision(): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await readFile('.git-info', 'utf-8'))
    if (typeof manifest !== 'object' || manifest === null || !('commitHash' in manifest)) return null
    return typeof manifest.commitHash === 'string' && /^[a-f0-9]{7,40}$/.test(manifest.commitHash) ? manifest.commitHash : null
  }
  catch { return null }
}

/** Reads only existing runtime state; never starts DAC, Bluetooth, MQTT or a policy. */
export async function readCapabilities() {
  const revision = await readRevision()
  const monitor = getDacMonitorIfRunning()
  const base = getBaseControllerIfRunning()
  return buildCapabilities({
    now: Date.now(),
    revision,
    device: {
      status: monitor?.getLastStatus() ?? null,
      observedAt: monitor?.getLastPollAt() ?? null,
      current: monitor?.getFreshStatus(DEVICE_FRESHNESS_MS) != null,
    },
    base: base?.status() ?? null,
    mqttConnected: getBridgeStatus().connected,
    comfortActive: ['left', 'right'].some(side => getComfortRuntimeIfRunning()?.status(side as 'left' | 'right').activation.available === true),
    comfortPreviewRunning: getComfortRuntimeIfRunning()?.isRunning() ?? false,
    roomContextFresh: Object.keys(getRoomContext().signals()).length > 0,
  })
}
