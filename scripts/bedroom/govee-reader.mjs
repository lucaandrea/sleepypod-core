/** Headless, status-only Govee adapter. Account credentials remain in the existing Homebridge store. */
import { readFile, readdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { startGoveeReadLoop } from './govee-read-loop.mjs'

const SUPPORTED_PLUGIN_VERSION = '11.39.1'

function concreteTopic(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[+#\0]/.test(value)
}

/** Resolve one actual monitor and the already-authenticated account, without logging credential values. */
export async function loadGoveeProvider(config) {
  const packageFile = path.join(config.pluginRoot, 'package.json')
  const plugin = JSON.parse(await readFile(packageFile, 'utf8'))
  if (plugin.version !== SUPPORTED_PLUGIN_VERSION) throw new Error('Govee plugin version requires qualification')
  const require = createRequire(packageFile)
  const { device } = require('aws-iot-device-sdk')
  const { pfxToCertAndKey } = await import(pathToFileURL(path.join(config.pluginRoot, 'lib/utils/functions.js')))
  const { getDeviceCapabilities } = await import(pathToFileURL(path.join(config.pluginRoot, 'lib/utils/device-capabilities.js')))
  const cacheRoot = path.join(config.homebridgeRoot, 'bwp91_cache')
  const cache = await Promise.all((await readdir(cacheRoot)).map(async filename =>
    JSON.parse(await readFile(path.join(cacheRoot, filename), 'utf8'))))
  const accounts = cache.filter(item => item.key === 'Govee_All_Devices_temp')
  if (accounts.length !== 1 || typeof accounts[0].value !== 'string') throw new Error('Account cache unavailable')
  const fields = accounts[0].value.split(':::')
  if (fields.length !== 7 || !concreteTopic(fields[0])
    || !/^[a-z0-9-]+\.iot\.[a-z0-9-]+\.amazonaws\.com$/.test(fields[4])) throw new Error('Unexpected account routing')
  const accessoryRoot = path.join(config.homebridgeRoot, 'accessories')
  const accessories = (await Promise.all((await readdir(accessoryRoot))
    .filter(filename => filename.startsWith('cachedAccessories.'))
    .map(async filename => JSON.parse(await readFile(path.join(accessoryRoot, filename), 'utf8'))))).flat()
  const monitors = accessories.filter(accessory => accessory.context?.gvModel === 'H5106'
    && accessory.context.gvDeviceId === config.deviceId)
  if (monitors.length !== 1 || !concreteTopic(monitors[0].context.awsTopic)) throw new Error('Monitor routing unavailable')
  const identity = await pfxToCertAndKey(path.join(config.homebridgeRoot, 'persist/govee.pfx'), fields[5])
  const client = device({ privateKey: Buffer.from(identity.key), clientCert: Buffer.from(identity.cert),
    caCert: await readFile(path.join(config.pluginRoot, 'lib/connection/cert/AmazonRootCA1.pem')),
    clientId: `AP/${fields[3]}/hbsleepypod${randomBytes(8).toString('hex')}`,
    host: fields[4], enableMetrics: false, clean: true, keepalive: 30,
  })
  return { client, deviceId: config.deviceId, deviceTopic: monitors[0].context.awsTopic,
    accountTopic: fields[0], statusVersion: getDeviceCapabilities('H5106').awsStatusCmdVersion }
}

/** A dedicated forced-command key can submit only these receipts, never a remote shell command. */
export function publishRead(config, receipt) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.sshExecutable, ['-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
      '-o', `UserKnownHostsFile=${config.knownHosts}`, '-i', config.keyFile, '-p', String(config.podPort),
      `${config.podUser}@${config.podHost}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const deadline = setTimeout(() => child.kill(), 14000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > 16384) child.kill()
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', () => {
      clearTimeout(deadline)
      reject(new Error('Transport unavailable'))
    })
    child.on('close', (code) => {
      clearTimeout(deadline)
      try {
        const result = JSON.parse(output)
        if (code !== 0 || result.deviceReadOnly !== true || result.submitted !== 4 || result.accepted !== 4) {
          throw new Error('Receipt not accepted')
        }
        resolve(result)
      }
      catch { reject(new Error('Publication unavailable')) }
    })
    child.stdin.end(JSON.stringify(receipt))
  })
}

/** Serialize publication and preserve original clocks; stale queued receipts are discarded. */
export function receiptQueue(send, onStatus, now = Date.now) {
  let running = null
  let latest = null
  return function enqueue(receipt) {
    latest = receipt
    if (running) return running
    running = (async () => {
      while (latest) {
        const current = latest
        latest = null
        if (now() - current.observedAt > 15000 || current.observedAt - now() > 1000) {
          await onStatus({ error: 'receipt_expired', observedAt: current.observedAt })
          continue
        }
        try {
          await onStatus({ ...(await send(current)), receipt: current })
        }
        catch { await onStatus({ error: 'publication_unavailable', observedAt: current.observedAt }) }
      }
    })().finally(() => { running = null })
    return running
  }
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
  if (!['observe', 'publish'].includes(config.mode)) throw new Error('Expected an explicit reader mode')
  const once = process.argv.includes('--once')
  let loop
  let completed = false
  let lastQualifiedRead = null
  const status = async (value) => {
    if (value.receipt?.reading) lastQualifiedRead = value.receipt
    const contents = JSON.stringify({ mode: config.mode, checkedAt: new Date().toISOString(), lastQualifiedRead, ...value })
    await writeFile(config.statusFile + '.tmp', contents, { mode: 0o600 })
    await rename(config.statusFile + '.tmp', config.statusFile)
    if (once && value.receipt?.reading && !completed) {
      completed = true
      console.log(JSON.stringify({ observed: true, published: config.mode === 'publish', measurements: 4 }))
      setTimeout(async () => {
        await loop.stop()
        process.exit(0)
      }, 0)
    }
  }
  const queue = receiptQueue(receipt => config.mode === 'publish'
    ? publishRead(config, receipt)
    : Promise.resolve({ observedOnly: true }), status)
  loop = startGoveeReadLoop(await loadGoveeProvider(config), queue)
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => {
    const deadline = setTimeout(() => process.exit(1), 18000)
    await loop.stop()
    clearTimeout(deadline)
    process.exit(0)
  })
  if (once) setTimeout(async () => {
    if (completed) return
    completed = true
    await loop.stop()
    console.error('No qualified device reply arrived.')
    process.exit(1)
  }, 20000)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Govee reader stopped; inspect the private installation.')
    process.exitCode = 1
  })
}
