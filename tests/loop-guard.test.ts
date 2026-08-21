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
    registerLoopGuard(ctx, { listingLimit: () => 3, reviewerToolNames: () => [] })
    const agent = {}
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
  })

  it('denies the call past the limit', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 3, reviewerToolNames: () => [] })
    const agent = {}
    for (let i = 0; i < 3; i += 1) call('list_agents', agent)
    const denial = call('list_agents', agent)
    expect(denial).toContain('END YOUR RESPONSE NOW')
    expect(denial).toContain('4 times in a row')
  })

  it('tells the model that waiting is the absence of an action', () => {
    // 这是循环的根因：模型想「执行等待」，而唯一像等待的工具就是 list_agents。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [] })
    const agent = {}
    call('list_agents', agent)
    expect(call('list_agents', agent)).toContain('not an action you perform')
  })

  it('resets the streak on any other tool call', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 2, reviewerToolNames: () => [] })
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
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [] })
    const orchestrator = {}
    const child = {}
    call('list_agents', orchestrator)
    expect(call('list_agents', child)).toBeUndefined()
    expect(call('list_agents', orchestrator)).toContain('END YOUR RESPONSE NOW')
  })

  it('never touches tools other than list_agents', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [] })
    const agent = {}
    for (let i = 0; i < 50; i += 1) expect(call('read', agent)).toBeUndefined()
  })

  it('applies the limit read at call time, not at registration', () => {
    // 配置热更新后无需重挂 guard。
    let limit = 5
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => limit, reviewerToolNames: () => [] })
    const agent = {}
    call('list_agents', agent)
    call('list_agents', agent)
    limit = 1
    expect(call('list_agents', agent)).toContain('END YOUR RESPONSE NOW')
  })

  it('tracks the agentless execution path on its own counter', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [] })
    call('list_agents')
    expect(call('list_agents')).toContain('END YOUR RESPONSE NOW')
    expect(call('read')).toBeUndefined()
    expect(call('list_agents')).toBeUndefined()
  })
})

describe('duplicate reviewer dispatch', () => {
  const deps = { listingLimit: () => 3, reviewerToolNames: () => ['subagent_reviewer'] }

  it('allows the first dispatch of a review round', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    expect(call('subagent_reviewer', {})).toBeUndefined()
  })

  it('denies dispatching the same reviewer twice in a row', () => {
    // 真实会话里编排者用两段不同 prompt 派了同一个工具，自称「第二视角」——
    // 同一个 provider 与 model，不构成独立视角，只是成本翻倍。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    const denial = call('subagent_reviewer', agent)
    expect(denial).toContain('already dispatched')
    expect(denial).toContain('same provider and model')
  })

  it('points at send_message for re-review instead of a new dispatch', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    expect(call('subagent_reviewer', agent)).toContain('send_message')
  })

  it('allows the next review round after other work happened', () => {
    // 跨环节：spec 评审 → 写计划 → plan 评审。中间的调用清零计数。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    call('edit', agent)
    expect(call('subagent_reviewer', agent)).toBeUndefined()
  })

  it('tracks each reviewer tool separately when several models are configured', () => {
    // 配了多个模型的 reviewer 角色会挂出多个工具，同一环节各派一次是正确用法。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, {
      listingLimit: () => 3,
      reviewerToolNames: () => ['subagent_reviewer_ds', 'subagent_reviewer_kimi'],
    })
    const agent = {}
    expect(call('subagent_reviewer_ds', agent)).toBeUndefined()
    expect(call('subagent_reviewer_kimi', agent)).toBeUndefined()
    expect(call('subagent_reviewer_kimi', agent)).toContain('already dispatched')
  })

  it('leaves implementer dispatches alone', () => {
    // 逐任务实现要连续派发很多次 implementer，这条判据不该碰它。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    for (let i = 0; i < 15; i += 1) {
      expect(call('subagent_implementer', agent)).toBeUndefined()
    }
  })
})
