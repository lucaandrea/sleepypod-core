import { createPreviewReports } from './reports'
import { readFileSync } from 'node:fs'
import type { PreviewOrigin } from './report-evidence'
import { and, eq } from 'drizzle-orm'
import { biometricsDb, db, sqlite } from '@/src/db'
import { alarmSchedules, deviceSettings, deviceState, powerSchedules, sideSettings, temperatureSchedules } from '@/src/db/schema'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getBaseControllerIfRunning } from '@/src/hardware/base/instance'
import { hasFirmwareSynced } from '@/src/hardware/sideMutations'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { getOccupancy } from '@/src/lib/occupancy'
import { scheduleSourceSide } from '@/src/lib/singleSleeper'
import { getTemperatureControllerIfRunning } from '@/src/temperature/instance'
import { alarmTemperatureTargets } from '@/src/temperature/baseline'
import { DEVICE_MAX_AGE_MS, type ComfortContext, type ComfortState, type RoutineWindow } from './policy'
import { acknowledgeManualPause, pendingManualPause } from './manual'
import { comfortRoutineAt } from './routines'
import { ComfortRuntime } from './runtime'
import { createComfortStore } from './store'
import { ComfortSignalReader } from './signal-reader'

const globals = globalThis as typeof globalThis & { __sp_comfortRuntime?: ComfortRuntime, __sp_comfortSignals?: ComfortSignalReader }
function signalsReader() {
  return globals.__sp_comfortSignals ??= new ComfortSignalReader(biometricsDb.$client)
}

const routineCache: Partial<Record<Side, { key: string, window: RoutineWindow | null }>> = {}

function observedTimestamp(value: number | null | undefined, now: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now ? value : null
}

/** Read existing sensors and arbitration only; status evaluation never opens a hardware connection. */
export function readComfortContext(side: Side, state: ComfortState, now: number): { context: ComfortContext, timezone: string } {
  const settings = db.select().from(deviceSettings).get()
  if (!settings) throw new Error('Device settings unavailable')
  const sides = db.select().from(sideSettings).all()
  const source = scheduleSourceSide(side, { ...settings, ...Object.fromEntries(sides.map(row => [row.side, row])) })
  const powers = source ? db.select().from(powerSchedules).where(and(eq(powerSchedules.side, source), eq(powerSchedules.enabled, true))).all() : []
  const targets = source ? db.select().from(temperatureSchedules).where(and(eq(temperatureSchedules.side, source), eq(temperatureSchedules.enabled, true))).all() : []
  const alarms = source ? db.select().from(alarmSchedules).where(and(eq(alarmSchedules.side, source), eq(alarmSchedules.enabled, true))).all() : []
  const timezone = settings.timezone
  const schedules = { powers, targets, alarms, timezone, source: JSON.stringify([source, settings.bedMode, settings.unusedZoneMode]) }
  const key = JSON.stringify([Math.floor(now / 60_000), schedules])
  const cached = routineCache[side]
  const window = cached?.key === key ? cached.window : comfortRoutineAt(schedules, now)
  routineCache[side] = { key, window }
  const control = getTemperatureControllerIfRunning()?.status(side)
  const monitor = getDacMonitorIfRunning()
  const status = monitor?.getFreshStatus(DEVICE_MAX_AGE_MS)
  const reported = side === 'left' ? status?.leftSide : status?.rightSide
  const deviceObservedAt = status ? observedTimestamp(monitor?.getLastPollAt(), now) : null
  const occupancy = getOccupancy(side)
  const presenceObservedAt = occupancy.level.ageMs === null ? null : observedTimestamp(now - occupancy.level.ageMs, now)
  const states = db.select().from(deviceState).all()
  const mirror = states.find(row => row.side === side)
  const base = getBaseControllerIfRunning()?.status()
  const baseFresh = base?.state === 'connected' && !base.stale && base.lastUpdate !== null
    && observedTimestamp(base.lastUpdate, now) !== null && now - base.lastUpdate <= 10_000
  const alarmOverride = alarmTemperatureTargets(alarms.map(row => ({
    id: `alarm:${row.id}`, dayOfWeek: row.dayOfWeek, time: row.time,
    temperature: row.alarmTemperature, wakeWindow: row.wakeWindow, duration: row.duration,
  })), timezone, now).length > 0
  const targetF = typeof reported?.targetTemperature === 'number' && Number.isFinite(reported.targetTemperature) ? reported.targetTemperature : null
  return {
    timezone,
    context: {
      now, window,
      device: {
        observedAt: deviceObservedAt, powered: hasFirmwareSynced() && mirror?.isPowered === true && (reported?.heatingDuration ?? 0) > 0,
        waterAdequate: status?.waterLevel === 'ok' ? true : status?.waterLevel === 'low' ? false : null,
        priming: status?.isPriming !== false,
        vibrating: states.length !== 2 || states.some(row => row.isAlarmVibrating),
        baseMoving: baseFresh && typeof base?.moving === 'boolean' ? base.moving || base.busy : null,
        targetF,
      },
      presence: { observedAt: presenceObservedAt, available: occupancy.available, occupied: occupancy.classification === 'person',
        entry: occupancy.level.sampleAt !== undefined && occupancy.level.sourceKey
          ? {
              measuredAt: occupancy.level.sampleAt, sourceKey: occupancy.level.sourceKey,
              state: occupancy.level.active && occupancy.classification === 'person'
                ? 'present'
                : !occupancy.level.active && occupancy.classification === 'none' ? 'absent' : 'unknown',
            }
          : undefined,
      },
      eitherAway: sides.length !== 2 || sides.some(row => row.awayMode),
      routinesPaused: source === null,
      alarmOverride,
      owner: control?.source ?? null,
      targetKnown: targetF !== null && (targetF === window?.baselineF || targetF === control?.targetTemperature
        || (state.lastSegment === window?.segment && state.lastTargetF === targetF && state.lastAppliedAt > 0 && state.lastAppliedAt <= now)),
      signals: state.config.sensorAware ? signalsReader().read(side, timezone, now) : undefined,
    },
  }
}

function previewOrigin(): PreviewOrigin {
  let buildRevision: string | null = null
  try {
    const manifest: unknown = JSON.parse(readFileSync('.git-info', 'utf-8'))
    if (manifest && typeof manifest === 'object' && 'commitHash' in manifest
      && typeof manifest.commitHash === 'string' && /^[a-f0-9]{7,40}$/.test(manifest.commitHash)) buildRevision = manifest.commitHash
  }
  catch { /* Missing build identity stays visible in the report. */ }
  const environment = process.env.CI || process.env.NODE_ENV === 'test'
    ? 'test'
    : process.env.NODE_ENV === 'production' ? 'production' : 'development'
  return { environment, buildRevision }
}

export function getComfortRuntime(): ComfortRuntime {
  return globals.__sp_comfortRuntime ??= new ComfortRuntime({
    now: Date.now, origin: previewOrigin(), store: createComfortStore(sqlite), withSideLock, readContext: readComfortContext,
    timezone: () => {
      const settings = db.select({ timezone: deviceSettings.timezone }).from(deviceSettings).get()
      if (!settings) throw new Error('Device timezone unavailable')
      return settings.timezone
    },
    prepareSignals: (side, now) => signalsReader().prepare(side, db.select().from(deviceSettings).get()?.timezone ?? 'UTC', now),
    pendingPause: pendingManualPause, acknowledgePause: acknowledgeManualPause,
  })
}

export function getComfortRuntimeIfRunning(): ComfortRuntime | undefined {
  return globals.__sp_comfortRuntime
}
export async function startComfortPreview(): Promise<void> {
  await getComfortRuntime().start()
}
export async function stopComfortPreview(): Promise<void> {
  await globals.__sp_comfortRuntime?.stop()
}

/** Read/review endpoints do not start the Preview runtime or any hardware service. */
export function getPreviewReports() {
  return createPreviewReports(sqlite)
}
