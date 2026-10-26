import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { comfortConfigSchema, comfortFeedbackSchema, comfortStatusSchema } from '@/src/comfort/contract'
import { getComfortRuntime } from '@/src/comfort/instance'
import { ComfortInputError } from '@/src/comfort/runtime'
import { publicProcedure, router } from '../trpc'

const sideSchema = z.enum(['left', 'right'])

export const comfortRouter = router({
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
      if (input.config.mode === 'active' || input.config.followBedtime) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Only Off and Preview are available until the remaining adapters and qualification gates are complete.' })
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
