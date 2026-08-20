import { describe, expect, it } from 'vitest'
import { registerLoopGuard } from '../src/loop-guard.ts'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 记录 guard 回调的 tools 替身。
 *
 * `call` 的第二个参数是发起调用的 agent 身份（任意对象即可，guard 只用它做
 * WeakMap 的键）；省略表示无 agent 的执行路径。
 */
function fakeToolsCtx() {
  interface FakeExecution { name: string; agent?: object }
  let guard: ((execution: FakeExecution) => string | undefined) | undefined
  return {
    call: (name: string, agent?: object) => guard?.({ name, ...agent === undefined ? {} : { agent } }),
    ctx: { tools: { guard: (fn: typeof guard) => { guard = fn; return () => {} } } } as unknown as Context,
  }
}

describe('registerLoopGuard', () => {
  it('allows list_agents up to the limit', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 3 })
    const agent = {}
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
  })

  it('denies the call past the limit', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 3 })
    const agent = {}
    for (let i = 0; i < 3; i += 1) call('list_agents', agent)
    const denial = call('list_agents', agent)
    expect(denial).toContain('END YOUR RESPONSE NOW')
    expect(denial).toContain('4 times in a row')
  })

  it('tells the model that waiting is the absence of an action', () => {
    // 这是循环的根因：模型想「执行等待」，而唯一像等待的工具就是 list_agents。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 1 })
    const agent = {}
    call('list_agents', agent)
    expect(call('list_agents', agent)).toContain('not an action you perform')
  })

  it('resets the streak on any other tool call', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 2 })
    const agent = {}
    call('list_agents', agent)
    call('list_agents', agent)
    expect(call('read', agent)).toBeUndefined()
    // 计数清零：真实工作证明它在推进，之后又可以查两次。
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toContain('END YOUR RESPONSE NOW')
  })

  it('counts each agent separately', () => {
    // 子代理与编排者共用全局工具注册表，一个的轮询不该拖累另一个。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 1 })
    const orchestrator = {}
    const child = {}
    call('list_agents', orchestrator)
    expect(call('list_agents', child)).toBeUndefined()
    expect(call('list_agents', orchestrator)).toContain('END YOUR RESPONSE NOW')
  })

  it('never touches tools other than list_agents', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 1 })
    const agent = {}
    for (let i = 0; i < 50; i += 1) expect(call('read', agent)).toBeUndefined()
  })

  it('applies the limit read at call time, not at registration', () => {
    // 配置热更新后无需重挂 guard。
    let limit = 5
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => limit })
    const agent = {}
    call('list_agents', agent)
    call('list_agents', agent)
    limit = 1
    expect(call('list_agents', agent)).toContain('END YOUR RESPONSE NOW')
  })

  it('tracks the agentless execution path on its own counter', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { limit: () => 1 })
    call('list_agents')
    expect(call('list_agents')).toContain('END YOUR RESPONSE NOW')
    expect(call('read')).toBeUndefined()
    expect(call('list_agents')).toBeUndefined()
  })
})
