import { describe, expect, it, vi } from 'vitest'
import { withSideLock } from '@/src/hardware/sideLock'
import { beforeControlWrite, ControlDeadlineError, outsideControlRequest, withinControlRequest } from '../context'
import { testScope } from './fixtures'

describe('control dispatch context', () => {
  it('rechecks expiry after waiting for the side lock', async () => {
    const gate = Promise.withResolvers<undefined>()
    const earlier = withSideLock('left', () => gate.promise)
    const scope = testScope()
    const execute = vi.fn(async () => {})
    const pending = withinControlRequest(scope, () => withSideLock('left', execute))
    const rejected = expect(pending).rejects.toBeInstanceOf(ControlDeadlineError)
    scope.now = () => 200
    gate.resolve(undefined)
    await earlier
    await rejected
    expect(execute).not.toHaveBeenCalled()
    await withSideLock('left', execute)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects orphan callbacks after completion and explicitly detaches independent work', async () => {
    const scope = testScope()
    const gate = Promise.withResolvers<undefined>()
    let orphan!: Promise<void>
    let detached!: Promise<void>
    await withinControlRequest(scope, async () => {
      orphan = gate.promise.then(() => {
        beforeControlWrite()
      })
      detached = outsideControlRequest(() => gate.promise.then(() => {
        beforeControlWrite()
      }))
    })
    const rejected = expect(orphan).rejects.toBeInstanceOf(ControlDeadlineError)
    gate.resolve(undefined)
    await rejected
    await detached
    expect(scope.beforeDispatch).not.toHaveBeenCalled()
  })
})
