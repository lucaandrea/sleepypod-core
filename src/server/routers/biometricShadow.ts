import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { ShadowStore } from '@/src/biometrics/shadow/store'
import { describeShadowRun, shadowRunDescriptorSchema, shadowRunPageSchema } from '@/src/biometrics/shadow/descriptors'
import { cancelShadowServiceAttempt } from '@/src/biometrics/shadow/service-host'

const idSchema = z.object({ id: z.string().uuid() }).strict()
async function inspect<T>(action: (store: ShadowStore) => T | Promise<T>) {
  try {
    // Inspection/cancellation remains available when execution is unconfigured.
    return await action(new ShadowStore(biometricsDb.$client))
  }
  catch (error) {
    if (error instanceof Error && error.message === 'Unknown shadow run') throw new TRPCError({ code: 'NOT_FOUND', message: 'Shadow run not found' })
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Shadow operation failed', cause: error })
  }
}

export const biometricShadowRouter = router({
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
