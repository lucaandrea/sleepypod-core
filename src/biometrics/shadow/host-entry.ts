// Shipped, fingerprinted host API. Importing this module opens no database,
// starts no service, subscribes to no source and performs no hardware command.
export { runProfiledShadowAttempt, openProfiledShadowHost } from './host'
export { prepareShadowPlan } from './preparation'
export { ShadowStore, shadowPlanSchema, shadowStoragePolicySchema } from './store'
export { shadowEngineBuildIdentity } from './build'
export { readInstalledShadowQualifications } from './admission'
export const shadowHostApiVersion = 'shadow-host-api-v1' as const
