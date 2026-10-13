import { z } from 'zod'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { shadowQualificationSchema } from './admission'
import type { inspectInstalledShadowHost } from './installed-host'

/** Observe the existing successful status poll only; never start polling or send
 * a DAC command. Preserve exact hardware revision without retaining serials.
 * The general UI parser's unknown-label fallback is not qualification evidence. */
export function observedShadowHardware(maximumAgeMs: number, now = Date.now()) {
  z.number().int().positive().max(300000).parse(maximumAgeMs)
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(now)
  const monitor = getDacMonitorIfRunning()
  if (!monitor || monitor.getStatus() !== 'running') throw new Error('Shadow hardware observation unavailable')
  const observedAtMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(monitor.getLastPollAt())
  if (observedAtMs > now || now - observedAtMs > maximumAgeMs) throw new Error('Shadow hardware observation stale or future')
  const status = z.object({ podVersion: z.enum(['H00', 'I00', 'J00']), sensorLabel: z.string().min(1).max(1000) }).parse(monitor.getLastStatus())
  const revision = status.sensorLabel.split('-').reverse().find(segment => /^[A-Z]\d{2}$/.test(segment))
  if (!revision || !/^[HIJ]\d{2}$/.test(revision) || status.podVersion !== `${revision[0]}00`) throw new Error('Shadow sensor hardware revision unavailable or inconsistent')
  return { hardwareId: `pod-sensor-v1/${status.podVersion}/${revision}`, sampleRateHz: 500 as const }
}

/** Called by the application, outside the passive packaged host. Every admission
 * observes current hardware and rechecks the loaded Node/Python artifacts. */
export function installedShadowIdentity(inspection: Awaited<ReturnType<typeof inspectInstalledShadowHost>>, rawQualification: unknown) {
  const qualification = shadowQualificationSchema.parse(rawQualification)
  const engineBuildHash = inspection.build.hash, pythonBuildHash = inspection.build.python.hash
  const assertCurrent = inspection.assertCurrent
  if (engineBuildHash !== qualification.engineBuildHash || pythonBuildHash !== qualification.pythonBuildHash) throw new Error('Shadow installed build differs from qualification')
  return () => {
    assertCurrent()
    const hardware = observedShadowHardware(qualification.maximumHardwareObservationAgeMs)
    if (hardware.hardwareId !== qualification.hardwareId || hardware.sampleRateHz !== qualification.sampleRateHz) throw new Error('Shadow hardware differs from qualification')
    return { engineBuildHash, pythonBuildHash, ...hardware }
  }
}
