import { isAbsolute } from 'node:path'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as configSchema from '@/src/db/schema'
import type * as biometricsSchema from '@/src/db/biometrics-schema'
import { z } from 'zod'
import { packagedShadowHostPath } from '../backtest/location'
import { shadowStoragePolicySchema } from './store'
import { startShadowService } from './service-host'
import { shadowPlanTemplateSchema } from './preparation-contracts'

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected absolute installation path')
export const shadowServiceConfigurationSchema = z.object({
  version: z.literal('shadow-service-configuration-v1'),
  pythonPath: absolutePath,
  modulesPath: absolutePath,
  presenceFile: absolutePath,
  storagePolicy: shadowStoragePolicySchema,
  busyTimeoutMs: z.number().int().min(1).max(1000),
  recoveryIntervalMs: z.number().int().min(10).max(300000),
  recoveryMaximumRuns: z.number().int().min(1).max(100),
  planTemplates: z.array(shadowPlanTemplateSchema).max(8).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate shadow template IDs').optional(),
}).strict().refine(value => (value.planTemplates ?? []).every(template => template.maximumPoints <= value.storagePolicy.maximumPoints
  && template.maximumBytes <= value.storagePolicy.maximumBytes), 'Shadow templates exceed deployment storage policy')

/** Environment configuration is an operator-owned resource policy, not evidence
 * of qualification. Every execution still verifies the installed qualification
 * registry, current build, acknowledged bindings and observed pod health. */
export function configuredShadowService() {
  const raw = process.env.SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE
  if (raw === undefined) return null
  if (Buffer.byteLength(raw) > 16384) throw new Error('Shadow service configuration too large')
  return shadowServiceConfigurationSchema.parse(JSON.parse(raw))
}

/** Resolve databases from the running app, never from an API/request or an
 * independently configured database URL. Missing configuration leaves no timer,
 * database connection, Python probe or sensor subscription behind. */
export function startConfiguredShadowService(configuration: BetterSQLite3Database<typeof configSchema>,
  biometrics: BetterSQLite3Database<typeof biometricsSchema>) {
  try {
    const options = configuredShadowServiceOptions(configuration, biometrics)
    return options ? startShadowService(options) : null
  }
  catch {
    // Avoid exposing deployment paths or arbitrary environment content in logs.
    console.warn('[biometrics] Shadow service unavailable; check deployment configuration and installed package')
    return null
  }
}

/** Resolve server-owned paths for submission without starting background work. */
export function configuredShadowServiceOptions(configuration: BetterSQLite3Database<typeof configSchema>,
  biometrics: BetterSQLite3Database<typeof biometricsSchema>) {
  const options = configuredShadowService()
  if (!options) return null
  const configurationDatabase = absolutePath.parse(configuration.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file)
  const biometricsDatabase = absolutePath.parse(biometrics.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file)
  if (configurationDatabase === biometricsDatabase) throw new Error('Shadow databases must be separate')
  return { installation: { workerPath: packagedShadowHostPath(),
    pythonPath: options.pythonPath, modulesPath: options.modulesPath, presenceFile: options.presenceFile,
    configurationDatabase, biometricsDatabase }, storagePolicy: options.storagePolicy,
  busyTimeoutMs: options.busyTimeoutMs, recoveryIntervalMs: options.recoveryIntervalMs,
  recoveryMaximumRuns: options.recoveryMaximumRuns }
}
