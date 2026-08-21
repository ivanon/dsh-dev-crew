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
  interface FakeExecution { name: string; agent?: object; arguments?: unknown }
  let guard: ((execution: FakeExecution) => string | undefined) | undefined
  return {
    call: (name: string, agent?: object, args?: unknown) => guard?.({
      name,
      ...agent === undefined ? {} : { agent },
      ...args === undefined ? {} : { arguments: args },
    }),
    ctx: { tools: { guard: (fn: typeof guard) => { guard = fn; return () => {} } } } as unknown as Context,
  }
}

describe('registerLoopGuard', () => {
  it('allows list_agents up to the limit', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 3, reviewerToolNames: () => [], roleToolNames: () => [] })
    const agent = {}
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
    expect(call('list_agents', agent)).toBeUndefined()
  })

  it('denies the call past the limit', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 3, reviewerToolNames: () => [], roleToolNames: () => [] })
    const agent = {}
    for (let i = 0; i < 3; i += 1) call('list_agents', agent)
    const denial = call('list_agents', agent)
    expect(denial).toContain('END YOUR RESPONSE NOW')
    expect(denial).toContain('4 times in a row')
  })

  it('tells the model that waiting is the absence of an action', () => {
    // 这是循环的根因：模型想「执行等待」，而唯一像等待的工具就是 list_agents。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [], roleToolNames: () => [] })
    const agent = {}
    call('list_agents', agent)
    expect(call('list_agents', agent)).toContain('not an action you perform')
  })

  it('resets the streak on any other tool call', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 2, reviewerToolNames: () => [], roleToolNames: () => [] })
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
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [], roleToolNames: () => [] })
    const orchestrator = {}
    const child = {}
    call('list_agents', orchestrator)
    expect(call('list_agents', child)).toBeUndefined()
    expect(call('list_agents', orchestrator)).toContain('END YOUR RESPONSE NOW')
  })

  it('never touches tools other than list_agents', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [], roleToolNames: () => [] })
    const agent = {}
    for (let i = 0; i < 50; i += 1) expect(call('read', agent)).toBeUndefined()
  })

  it('applies the limit read at call time, not at registration', () => {
    // 配置热更新后无需重挂 guard。
    let limit = 5
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => limit, reviewerToolNames: () => [], roleToolNames: () => [] })
    const agent = {}
    call('list_agents', agent)
    call('list_agents', agent)
    limit = 1
    expect(call('list_agents', agent)).toContain('END YOUR RESPONSE NOW')
  })

  it('tracks the agentless execution path on its own counter', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, { listingLimit: () => 1, reviewerToolNames: () => [], roleToolNames: () => [] })
    call('list_agents')
    expect(call('list_agents')).toContain('END YOUR RESPONSE NOW')
    expect(call('read')).toBeUndefined()
    expect(call('list_agents')).toBeUndefined()
  })
})

describe('duplicate reviewer dispatch', () => {
  const deps = { listingLimit: () => 3, reviewerToolNames: () => ['subagent_reviewer'], roleToolNames: () => ['subagent_reviewer', 'subagent_implementer'] }

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
      roleToolNames: () => ['subagent_reviewer_ds', 'subagent_reviewer_kimi'],
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

describe('placeholder questions', () => {
  const deps = { listingLimit: () => 3, reviewerToolNames: () => ['subagent_reviewer'], roleToolNames: () => ['subagent_reviewer', 'subagent_implementer'] }
  const ask = (options?: unknown[]) => ({
    questions: [{ id: 'q', question: '?', ...options === undefined ? {} : { options } }],
  })

  it('denies a question whose options list is empty', () => {
    // 真实会话：派出 reviewer 后用 {id:"placeholder", header:"Wait", options:[]}
    // 假装等待，流水线卡在一个无法回答的选择框上。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const denial = call('ask_user_question', {}, ask([]))
    expect(denial).toContain('empty options list')
    expect(denial).toContain('END YOUR RESPONSE NOW')
  })

  it('names the filler forms so it stops looking for another one', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    expect(call('ask_user_question', {}, ask([]))).toContain('bash echo')
  })

  it('allows a free-text question that omits options', () => {
    // 省略 options 是合法的自由输入题，不是占位。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    expect(call('ask_user_question', {}, ask())).toBeUndefined()
  })

  it('allows a normal multiple-choice question', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    expect(call('ask_user_question', {}, ask([{ label: 'A' }, { label: 'B' }]))).toBeUndefined()
  })

  it('denies when any one question in a batch is empty', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const args = { questions: [{ id: 'a', question: '?', options: [{ label: 'A' }] }, { id: 'b', question: '?', options: [] }] }
    expect(call('ask_user_question', {}, args)).toContain('empty options list')
  })

  it('does not count ask_user_question toward the polling streak', () => {
    // brainstorm 环节合法地连续提问，一次一个问题。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    for (let i = 0; i < 10; i += 1) {
      expect(call('ask_user_question', agent, ask([{ label: 'A' }]))).toBeUndefined()
    }
  })
})

describe('asking while waiting', () => {
  const deps = {
    listingLimit: () => 3,
    reviewerToolNames: () => ['subagent_reviewer'],
    roleToolNames: () => ['subagent_reviewer', 'subagent_implementer'],
  }
  const ask = { questions: [{ id: 'q', question: '继续等待还是中止？', options: [{ label: '等' }, { label: '中止' }] }] }

  it('denies a well-formed question right after a dispatch', () => {
    // 第四种假等待形态：两个像样的选项，既非空列表也不与派发相邻计数。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    const denial = call('ask_user_question', agent, ask)
    expect(denial).toContain('waiting phase')
    expect(denial).toContain('END YOUR RESPONSE NOW')
  })

  it('keeps denying across intervening list_agents calls', () => {
    // 真实会话：派发 → list_agents ×3 → 提问。中间的轮询不算工作，等待期不解除。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    call('list_agents', agent)
    call('list_agents', agent)
    expect(call('ask_user_question', agent, ask)).toContain('waiting phase')
  })

  it('keeps denying repeated attempts', () => {
    // 拒绝一次就放行的话，它只要再问一遍就能把等待推给用户。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    expect(call('ask_user_question', agent, ask)).toContain('waiting phase')
    expect(call('ask_user_question', agent, ask)).toContain('waiting phase')
    expect(call('ask_user_question', agent, ask)).toContain('waiting phase')
  })

  it('allows questions again once real work happened', () => {
    // 收到回报后编排者会读文件、改文件——那说明它在处理结果而不是在等。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_reviewer', agent)
    call('read', agent)
    expect(call('ask_user_question', agent, ask)).toBeUndefined()
  })

  it('allows brainstorm questions before any dispatch', () => {
    // 需求讨论环节合法地连续提问，那时还没派出任何子代理。
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    for (let i = 0; i < 8; i += 1) {
      expect(call('ask_user_question', agent, ask)).toBeUndefined()
    }
  })

  it('treats an implementer dispatch the same way', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_implementer', agent)
    expect(call('ask_user_question', agent, ask)).toContain('waiting phase')
  })

  it('names the dispatched tool in the denial', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const agent = {}
    call('subagent_implementer', agent)
    expect(call('ask_user_question', agent, ask)).toContain('subagent_implementer')
  })

  it('scopes the waiting phase per agent', () => {
    const { call, ctx } = fakeToolsCtx()
    registerLoopGuard(ctx, deps)
    const orchestrator = {}
    const other = {}
    call('subagent_reviewer', orchestrator)
    expect(call('ask_user_question', other, ask)).toBeUndefined()
    expect(call('ask_user_question', orchestrator, ask)).toContain('waiting phase')
  })
})
