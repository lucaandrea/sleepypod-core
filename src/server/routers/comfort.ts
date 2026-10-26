import { previewReportDetailSchema, previewReportListSchema, previewReviewInputSchema, previewReviewSchema, reportIdSchema } from '@/src/comfort/report-contract'
import { PreviewReportError } from '@/src/comfort/report-summary'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { comfortConfigSchema, comfortFeedbackSchema, comfortStatusSchema } from '@/src/comfort/contract'
import { getComfortRuntime, getPreviewReports } from '@/src/comfort/instance'
import { ComfortInputError } from '@/src/comfort/runtime'
import { publicProcedure, router } from '../trpc'

const sideSchema = z.enum(['left', 'right'])
async function reportResult<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof PreviewReportError) throw new TRPCError({ code: error.code, message: error.message })
    throw error
  }
}

export const comfortRouter = router({
  reports: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/reports', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(previewReportListSchema)
    .query(({ input }) => reportResult(() => getPreviewReports().list(input.side))),
  report: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/report', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, id: reportIdSchema, afterId: z.number().int().positive().optional() }).strict())
    .output(previewReportDetailSchema)
    .query(({ input }) => reportResult(() => getPreviewReports().detail(input.side, input.id, input.afterId))),
  reviewReport: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/report/review', tags: ['Autopilot'] } })
    .input(previewReviewInputSchema)
    .output(previewReviewSchema)
    .mutation(({ input }) => reportResult(() => getPreviewReports().review(input))),
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(comfortStatusSchema)
    .query(({ input }) => getComfortRuntime().status(input.side)),
  configure: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/configure', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, config: comfortConfigSchema }).strict())
    .output(comfortStatusSchema)
    .mutation(async ({ input }) => {
      if (input.config.mode === 'active') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Only Off and Preview are available until the remaining adapters and qualification gates are complete.' })
      }
      if (input.config.followBedtime && !input.config.sensorAware) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Bed-entry timing requires the Pod sensor guard.' })
      }
      return getComfortRuntime().configure(input.side, input.config)
    }),
  feedback: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/feedback', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, feedback: comfortFeedbackSchema }).strict())
    .output(comfortStatusSchema)
    .mutation(async ({ input }) => {
      try {
        return await getComfortRuntime().feedback(input.side, input.feedback)
      }
      catch (error) {
        if (error instanceof ComfortInputError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
        throw error
      }
    }),
})
