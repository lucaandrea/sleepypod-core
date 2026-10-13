import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { ShadowStore } from '@/src/biometrics/shadow/store'
import { describeShadowRun, shadowRunDescriptorSchema, shadowRunPageSchema } from '@/src/biometrics/shadow/descriptors'
import { cancelShadowServiceAttempt, startShadowService } from '@/src/biometrics/shadow/service-host'
import { coordinatorRequest } from '@/src/biometrics/backtest/coordinator-service'
import { ReferenceInputError } from '@/src/biometrics/references/time'
import { shadowReportRequestSchema, shadowReportSchema } from '@/src/biometrics/shadow/report-contracts'
import { submitShadowSchema, submitInstalledShadow } from '@/src/biometrics/shadow/submission'
import { configuredShadowServiceOptions } from '@/src/biometrics/shadow/startup'
import { configuredShadowTemplates, prepareInstalledShadow } from '@/src/biometrics/shadow/installed-preparation'
import { prepareShadowRequestSchema, preparedShadowPlanSchema, shadowTemplatePageSchema } from '@/src/biometrics/shadow/preparation-contracts'

const idSchema = z.object({ id: z.string().uuid() }).strict()
async function inspect<T>(action: (store: ShadowStore) => T | Promise<T>) {
  try {
    // Inspection/cancellation remains available when execution is unconfigured.
    return await action(new ShadowStore(biometricsDb.$client))
  }
  catch (error) {
    if (error instanceof Error && error.message === 'Shadow idempotency conflict') throw new TRPCError({ code: 'CONFLICT', message: 'Shadow idempotency conflict' })
    if (error instanceof Error && error.message === 'Shadow window must be prospective') throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
    if (error instanceof Error && ['Shadow plan exceeds storage policy', 'Shadow run quota exceeded'].includes(error.message)) throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: error.message })
    if (error instanceof ReferenceInputError) throw new TRPCError({ code: error.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'RESOURCE_LIMIT' ? 'PAYLOAD_TOO_LARGE' : error.code === 'SUBJECT_MISMATCH' ? 'BAD_REQUEST' : 'SERVICE_UNAVAILABLE',
    message: error.message, cause: error })
    if (error instanceof Error && error.message === 'Unknown shadow run') throw new TRPCError({ code: 'NOT_FOUND', message: 'Shadow run not found' })
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Shadow operation failed', cause: error })
  }
}

export const biometricShadowRouter = router({
  templates: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/shadow-templates', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({}).strict()).output(shadowTemplatePageSchema)
    .query(() => inspect(() => configuredShadowTemplates())),
  prepare: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/shadow-plans/prepare', protect: false, tags: ['Biometric tuning'] } })
    .input(prepareShadowRequestSchema).output(preparedShadowPlanSchema)
    .mutation(({ input }) => inspect(() => {
      const options = configuredShadowServiceOptions(db, biometricsDb)
      if (!options) throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Shadow execution is not configured')
      return prepareInstalledShadow(input, options.installation, options.busyTimeoutMs)
    })),
  create: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/shadow-runs', protect: false, tags: ['Biometric tuning'] } })
    .input(submitShadowSchema).output(shadowRunDescriptorSchema)
    .mutation(({ input }) => inspect(async () => {
      const options = configuredShadowServiceOptions(db, biometricsDb)
      if (!options) throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Shadow execution is not configured')
      startShadowService(options)
      return describeShadowRun(await submitInstalledShadow(input, options.installation, options.storagePolicy, options.busyTimeoutMs))
    })),
  report: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/shadow-runs/{id}/report', protect: false, tags: ['Biometric tuning'] } })
    .input(idSchema).output(shadowReportSchema)
    .query(({ input }) => inspect(() => coordinatorRequest(biometricsDb, { type: 'readShadowReport', input }))),
  compare: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/shadow-runs/{id}/compare', protect: false, tags: ['Biometric tuning'] } })
    .input(shadowReportRequestSchema.extend({ reference: shadowReportRequestSchema.shape.reference.unwrap() })).output(shadowReportSchema)
    .mutation(({ input }) => inspect(() => coordinatorRequest(biometricsDb, { type: 'readShadowReport', input }))),
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/shadow-runs', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: z.enum(['left', 'right']), maximumRuns: z.number().int().min(1).max(50).default(20), afterId: z.string().uuid().optional() }).strict())
    .output(shadowRunPageSchema)
    .query(({ input }) => inspect((store) => {
      const page = store.list(input)
      return { ...page, items: page.items.map(describeShadowRun) }
    })),
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/shadow-runs/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(idSchema).output(shadowRunDescriptorSchema)
    .query(({ input }) => inspect(store => describeShadowRun(store.get(input.id)))),
  stop: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/shadow-runs/{id}/stop', protect: false, tags: ['Biometric tuning'] } })
    .input(idSchema)
    .output(z.object({ run: shadowRunDescriptorSchema, localAttemptSettled: z.boolean() }).strict())
    .mutation(({ input }) => inspect(async (store) => {
      // Revoke durable authority first, then await any locally owned execution.
      // This does not assert that a worker owned by another process was reaped.
      store.stop(input.id, 'operator_requested')
      const localAttemptSettled = await cancelShadowServiceAttempt(input.id)
      return { run: describeShadowRun(store.get(input.id)), localAttemptSettled }
    })),
})
