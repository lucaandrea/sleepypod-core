import type { z } from 'zod'
import type { runInstalledShadowAttempt } from './installed-attempt'
import { openShadowActiveDatabase } from './active-database'
import { loadInstalledShadowHost } from './installed-host'
import { prepareShadowRequestSchema, shadowPlanTemplateSchema, shadowTemplatePageSchema } from './preparation-contracts'
import { configuredShadowService } from './startup'

export function configuredShadowTemplates() {
  return shadowTemplatePageSchema.parse({ items: (configuredShadowService()?.planTemplates ?? []).map(({ id, label, maximumWindowMs }) => ({ id, label, maximumWindowMs })) })
}

/** Fixed server paths and package implementation; no Python probe or sources.
 * A prepared response cannot be submitted without ordinary creation admission. */
export function prepareInstalledShadow(raw: z.input<typeof prepareShadowRequestSchema>,
  installation: Parameters<typeof runInstalledShadowAttempt>[2], busyTimeoutMs: number) {
  const request = prepareShadowRequestSchema.parse(raw)
  const templates = configuredShadowService()?.planTemplates ?? []
  const matches = templates.filter(template => template.id === request.templateId)
  if (matches.length !== 1) throw new Error('Shadow template unavailable')
  const template = shadowPlanTemplateSchema.parse(matches[0])
  if (busyTimeoutMs > template.execution.sources.databaseBusyTimeoutMs) throw new Error('Shadow store timeout exceeds template policy')
  const loaded = loadInstalledShadowHost(installation.workerPath)
  loaded.assertCurrent()
  const configuration = openShadowActiveDatabase(installation.configurationDatabase, { busyTimeoutMs })
  let biometrics: ReturnType<typeof openShadowActiveDatabase> | undefined
  try {
    biometrics = openShadowActiveDatabase(installation.biometricsDatabase, { busyTimeoutMs })
    const bio = biometrics
    const guard = () => {
      loaded.assertCurrent()
      configuration.assertCurrent()
      bio.assertCurrent()
    }
    const prepared = loaded.api.prepareShadowPlan(configuration.db, bio.db, request, template, installation.workerPath, guard)
    guard()
    return prepared
  }
  finally {
    try {
      configuration.close()
    }
    finally { biometrics?.close() }
  }
}
