import { z } from 'zod'
import type { BaseStatus } from '@/src/hardware/base/types'
import type { DeviceStatus } from '@/src/hardware/types'

export const DEVICE_FRESHNESS_MS = 15_000
export const BASE_FRESHNESS_MS = 10_000

const observationSchema = z.object({
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  observedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
})
const featureSchema = z.object({
  implemented: z.boolean(),
  runtime: z.enum(['ready', 'not_ready', 'unknown']),
  reason: z.string(),
  physicalVerification: z.enum(['unverified', 'not_applicable']),
})
type Feature = z.infer<typeof featureSchema>

export const capabilitiesSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  controller: z.object({
    id: z.literal('sleepypod-core'),
    upstreamBaseline: z.literal('3.4.0'),
    revision: z.string().nullable(),
  }),
  endpoints: z.object({
    rest: z.literal('/api'),
    trpc: z.literal('/api/trpc'),
    openapi: z.literal('/api/openapi.json'),
    nativeCompatibility: z.string().startsWith('/api/').nullable(),
  }),
  authentication: z.object({ required: z.literal(true), bearer: z.literal(true), browserSession: z.literal(true) }),
  observations: z.object({ device: observationSchema, base: observationSchema }),
  features: z.object({
    deviceTelemetry: featureSchema,
    temperatureControl: featureSchema,
    basePosition: featureSchema,
    baseMovement: featureSchema,
    baseStop: featureSchema,
    wakeVibration: featureSchema,
    personalComfort: featureSchema,
    musicVibration: featureSchema,
    mqtt: featureSchema,
    homeContext: featureSchema,
    nativeCompatibility: featureSchema,
  }),
  baseScope: z.literal('whole_bed'),
  controlSemantics: z.object({
    acknowledgment: z.literal('accepted_not_physically_verified'),
    durableCommandReceipts: z.boolean(),
    commandExpiry: z.boolean(),
  }),
})
export type ControllerCapabilities = z.infer<typeof capabilitiesSchema>

export interface CapabilitySnapshot {
  now: number
  revision: string | null
  device: { status: DeviceStatus | null, observedAt: number | null, current: boolean }
  base: BaseStatus | null
  mqttConnected: boolean
}

/** Preserve a valid old timestamp, but never label malformed or future data fresh. */
function observation(at: number | null, maxAgeMs: number, now: number, present: boolean, current: boolean): z.infer<typeof observationSchema> {
  const valid = present && at !== null && Number.isSafeInteger(at) && at > 0 && at <= now
  if (!valid) return { freshness: 'unavailable', observedAt: null, expiresAt: null }
  return {
    freshness: current && now - at < maxAgeMs ? 'fresh' : 'stale',
    observedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + maxAgeMs).toISOString(),
  }
}

function feature(runtime: Feature['runtime'], reason: string, physical = false, implemented = true): Feature {
  return { implemented, runtime, reason, physicalVerification: physical ? 'unverified' : 'not_applicable' }
}

/** Capabilities describe evidence and implementation; they never authorize a command. */
export function buildCapabilities(snapshot: CapabilitySnapshot): ControllerCapabilities {
  const { now, device, base } = snapshot
  const deviceObservation = observation(device.observedAt, DEVICE_FRESHNESS_MS, now, device.status !== null, device.current)
  const baseObservation = observation(base?.lastUpdate ?? null, BASE_FRESHNESS_MS, now, base?.position != null, base?.state === 'connected' && !base.stale)
  const deviceFresh = deviceObservation.freshness === 'fresh'
  const baseFresh = baseObservation.freshness === 'fresh'
  const thermalReady = deviceFresh && device.status?.waterLevel === 'ok' && !device.status.isPriming
  const thermalReason = !deviceFresh ? 'device_report_unavailable' : device.status?.isPriming ? 'priming' : device.status?.waterLevel !== 'ok' ? 'water_not_ready' : 'fresh_device_report'
  const baseReady = baseFresh && base?.moving === false && !base.busy
  const baseReason = !baseFresh ? 'base_report_unavailable' : base?.busy || base?.moving ? 'base_busy' : base?.moving === null ? 'base_motion_unknown' : 'fresh_base_report'
  return {
    apiVersion: 1,
    generatedAt: new Date(now).toISOString(),
    controller: { id: 'sleepypod-core', upstreamBaseline: '3.4.0', revision: snapshot.revision },
    endpoints: { rest: '/api', trpc: '/api/trpc', openapi: '/api/openapi.json', nativeCompatibility: null },
    authentication: { required: true, bearer: true, browserSession: true },
    observations: { device: deviceObservation, base: baseObservation },
    features: {
      deviceTelemetry: feature(deviceFresh ? 'ready' : 'not_ready', deviceFresh ? 'fresh_device_report' : 'device_report_unavailable'),
      temperatureControl: feature(thermalReady ? 'ready' : 'not_ready', thermalReason, true),
      basePosition: feature(baseFresh ? 'ready' : 'not_ready', baseFresh ? 'fresh_base_report' : 'base_report_unavailable', true),
      baseMovement: feature(baseReady ? 'ready' : 'not_ready', baseReason, true),
      // Stop must remain visible and callable even when position is stale or motion is unknown.
      baseStop: feature(base?.state === 'connected' ? 'ready' : 'not_ready', base?.state === 'connected' ? 'base_connected' : 'base_disconnected', true),
      wakeVibration: feature(deviceFresh && !device.status?.isPriming ? 'ready' : 'not_ready', !deviceFresh ? 'device_report_unavailable' : device.status?.isPriming ? 'priming' : 'fresh_device_report', true),
      personalComfort: feature('not_ready', 'runtime_integration_pending', false, false),
      musicVibration: feature('not_ready', 'hardware_protocol_unqualified', true, false),
      mqtt: feature(snapshot.mqttConnected ? 'ready' : 'not_ready', snapshot.mqttConnected ? 'broker_connected' : 'broker_disconnected'),
      homeContext: feature('not_ready', 'room_context_integration_pending', false, false),
      nativeCompatibility: feature('not_ready', 'compatibility_api_pending', false, false),
    },
    baseScope: 'whole_bed',
    controlSemantics: { acknowledgment: 'accepted_not_physically_verified', durableCommandReceipts: false, commandExpiry: false },
  }
}
