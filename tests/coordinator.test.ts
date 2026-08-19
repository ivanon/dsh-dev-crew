import { describe, expect, it, vi } from 'vitest'
import { CrewCoordinator } from '../src/coordinator.ts'
import type { CoordinatorDeps } from '../src/coordinator.ts'
import type { CrewRole } from '../src/types.ts'

const live = [{ id: 'p1' }, { id: 'p2' }]

function role(id: string, provider: string, alias = 'default'): CrewRole {
  return { id, enabled: true, models: [{ alias, provider, model: 'm' }] }
}

function deps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    mount: async () => async () => {},
    readProviders: () => ({ live, configurable: [] }),
    onSkipped: () => {},
    onError: () => {},
    ...overrides,
  }
}

describe('CrewCoordinator', () => {
  it('mounts one tool per ready model on first sync', async () => {
    const mount = vi.fn(async () => async () => {})
    const c = new CrewCoordinator(deps({ mount }))
    await c.sync([role('implementer', 'p1')])
    expect(mount).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual(['subagent_implementer'])
  })

  it('does not remount an unchanged spec on a second sync', async () => {
    const mount = vi.fn(async () => async () => {})
    const c = new CrewCoordinator(deps({ mount }))
    const roles = [role('implementer', 'p1')]
    await c.sync(roles)
    await c.sync(roles)
    expect(mount).toHaveBeenCalledTimes(1)
  })

  it('disposes a tool whose role was removed', async () => {
    const dispose = vi.fn(async () => {})
    const c = new CrewCoordinator(deps({ mount: async () => dispose }))
    await c.sync([role('implementer', 'p1')])
    await c.sync([])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual([])
  })

  it('serializes concurrent syncs so the second observes the first', async () => {
    // 用非内置角色 id：BUILTIN_ROLES 命中 'implementer'/'reviewer' 时，
    // planMounts 的互斥 deny 列表会在第二次 sync 因新增角色而改写第一个角色
    // 的 config，触发与本测试目标无关的重挂载。
    const order: string[] = []
    const mount = vi.fn(async (spec: { toolName: string }) => {
      order.push(`start:${spec.toolName}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${spec.toolName}`)
      return async () => {}
    })
    const c = new CrewCoordinator(deps({ mount }))
    // roleA 预先声明 deny roleB 的工具名：mount.ts 的互斥 deny 逻辑（跨角色注入
    // 对方工具名到 toolFilter.deny）会在 roleB 首次出现时才把它加进 roleA 的
    // deny 列表；预先声明后两次 sync 推导出的 roleA config 一致，才能纯粹地
    // 验证队列串行化，而不与这条不相关的互斥业务规则相互影响。
    const roleA = { ...role('roleA', 'p1'), toolFilter: { deny: ['subagent_roleB'] } }
    // 两次 sync 不 await 第一次，模拟事件紧邻到达
    const first = c.sync([roleA])
    const second = c.sync([roleA, role('roleB', 'p2')])
    await Promise.all([first, second])
    // 第一次挂载完整结束后第二次才开始，且未重复挂载 roleA
    expect(order).toEqual([
      'start:subagent_roleA', 'end:subagent_roleA',
      'start:subagent_roleB', 'end:subagent_roleB',
    ])
    expect(c.mountedToolNames()).toEqual(['subagent_roleA', 'subagent_roleB'])
  })

  it('reports a mount failure through onError and leaves that tool unmounted', async () => {
    const onError = vi.fn()
    const c = new CrewCoordinator(deps({
      mount: async () => { throw new Error('INACTIVE_EFFECT') },
      onError,
    }))
    await c.sync([role('implementer', 'p1')])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual([])
  })

  it('does not leave the queue rejected after a mount failure', async () => {
    const c = new CrewCoordinator(deps({
      mount: async () => { throw new Error('boom') },
    }))
    await c.sync([role('implementer', 'p1')])
    // 后续 sync 仍能正常工作，说明队列未以被拒绝状态悬着
    await expect(c.sync([])).resolves.toBeUndefined()
  })

  it('reports a dispose failure through onError and still forgets the tool', async () => {
    const onError = vi.fn()
    const c = new CrewCoordinator(deps({
      mount: async () => async () => { throw new Error('dispose failed') },
      onError,
    }))
    await c.sync([role('implementer', 'p1')])
    await c.sync([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual([])
  })

  it('surfaces a duplicate tool name as an error without mounting anything', async () => {
    const mount = vi.fn(async () => async () => {})
    const onError = vi.fn()
    const c = new CrewCoordinator(deps({ mount, onError }))
    await c.sync([role('dup', 'p1'), role('dup', 'p2')])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(mount).not.toHaveBeenCalled()
  })

  it('passes skipped routes to onSkipped', async () => {
    const onSkipped = vi.fn()
    const c = new CrewCoordinator(deps({ onSkipped }))
    await c.sync([role('implementer', 'nope')])
    expect(onSkipped).toHaveBeenCalledWith([
      { toolName: 'subagent_implementer', provider: 'nope', reason: 'missing' },
    ])
  })

  it('disposes every mounted tool on dispose()', async () => {
    const dispose = vi.fn(async () => {})
    const c = new CrewCoordinator(deps({ mount: async () => dispose }))
    await c.sync([role('implementer', 'p1'), role('reviewer', 'p2')])
    await c.dispose()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(c.mountedToolNames()).toEqual([])
  })
})
