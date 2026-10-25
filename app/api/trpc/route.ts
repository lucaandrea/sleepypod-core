import { requireAccess } from '@/src/auth/access'
import { appRouter } from '@/src/server/routers/app'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

const handler = (req: Request) => {
  const denied = requireAccess(req)
  if (denied) return denied
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => ({}),
  })
}

export { handler as GET, handler as POST }
