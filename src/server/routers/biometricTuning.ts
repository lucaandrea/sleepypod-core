import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { sideSchema } from '@/src/server/validation-schemas'
import { normalizedMeasurementSchema, previewSummarySchema, referenceImportDescriptorSchema, referenceImportSchema } from '@/src/biometrics/references/contracts'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
import { commitReferenceSchema, ReferenceStore } from '@/src/biometrics/references/store'
import { compareReadingsSchema, comparisonReportSchema, compareStoredReadings } from '@/src/biometrics/references/comparison'
import { ReferenceInputError } from '@/src/biometrics/references/time'

/** UI and MCP call this shared service surface under the existing LAN trust model. */
function references<T>(action: (store: ReferenceStore) => T): T {
  try {
    return action(new ReferenceStore(biometricsDb))
  }
  catch (error) {
    if (error instanceof ReferenceInputError) {
      const code = error.code === 'NOT_FOUND' || error.code === 'REFERENCE_DELETED'
        ? 'NOT_FOUND'
        : error.code === 'STALE_PREVIEW' || error.code === 'REVISION_CONFLICT'
          ? 'CONFLICT'
          : error.code === 'RESOURCE_LIMIT' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'
      throw new TRPCError({ code, message: `${error.code}: ${error.message}`, cause: error })
    }
    throw error
  }
}
const importIdSchema = z.object({ id: z.string().uuid() }).strict()

export const biometricTuningRouter = router({
  compareReadings: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/compare', protect: false, tags: ['Biometric tuning'] } })
    .input(compareReadingsSchema)
    .output(comparisonReportSchema)
    .mutation(({ input }) => references(() => compareStoredReadings(biometricsDb, input))),

  previewImport: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/references/preview', protect: false, tags: ['Biometric tuning'] } })
    .input(referenceImportSchema)
    .output(previewSummarySchema)
    .mutation(({ input }) => references(() => previewReferenceImport(input).summary)),

  commitImport: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometric-tuning/references/commit', protect: false, tags: ['Biometric tuning'] } })
    .input(commitReferenceSchema)
    .output(referenceImportDescriptorSchema.extend({ alreadyImported: z.boolean() }))
    .mutation(({ input }) => references(store => store.commit(input))),

  listImports: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references', protect: false, tags: ['Biometric tuning'] } })
    .input(z.object({ side: sideSchema, beforeCreatedAtMs: z.number().int().nonnegative().optional(), beforeId: z.string().uuid().optional() }).strict()
      .refine(input => (input.beforeId === undefined) === (input.beforeCreatedAtMs === undefined), { message: 'Supply both cursor fields' }))
    .output(z.object({ items: z.array(referenceImportDescriptorSchema), nextCursor: z.object({ createdAtMs: z.number(), id: z.string().uuid() }).nullable() }))
    .query(({ input }) => references(store => store.list(input.side, input.beforeId !== undefined && input.beforeCreatedAtMs !== undefined
      ? { createdAtMs: input.beforeCreatedAtMs, id: input.beforeId }
      : undefined))),

  getImport: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(referenceImportDescriptorSchema)
    .query(({ input }) => references(store => store.get(input.id))),

  getImportMeasurements: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometric-tuning/references/{id}/measurements', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema.extend({ afterId: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(500) }))
    .output(z.object({ items: z.array(normalizedMeasurementSchema.extend({ id: z.number().int() })), nextCursor: z.number().int().nullable() }))
    .query(({ input }) => references(store => store.measurements(input.id, input.afterId, input.limit))),

  deleteImport: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/biometric-tuning/references/{id}', protect: false, tags: ['Biometric tuning'] } })
    .input(importIdSchema)
    .output(z.object({ id: z.string().uuid(), deletedAtMs: z.number().nullable() }))
    .mutation(({ input }) => references(store => store.delete(input.id))),
})
