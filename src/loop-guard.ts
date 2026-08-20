// 与 gate.ts 同一个理由用同步裸逻辑：ToolGuard 的签名是
// `(execution) => string | undefined`，无法 await。这条判据只读内存里的计数，
// 不触碰文件系统或网络。
import type { Context } from '@deepseek-ai/cordis'

/**
 * 被计数的工具名。
 *
 * `list_agents` 是编排者唯一能用来"查看子代理状态"的工具，因此也是它唯一能用来
 * 假装自己在等待的工具。真实会话里编排者连续调用它 149 次、单次会话累计 1069 次，
 * 把用户的模型额度耗尽（403 usage limit）才停下；期间子代理的回报消息已经到达，
 * 却没能打断这个循环。
 */
const WATCHED_TOOL = 'list_agents'

/** 计数状态：按发起调用的 Agent 分别累计，agent 被回收时自动释放。 */
interface LoopGuardState {
  readonly perAgent: WeakMap<object, number>
  agentless: number
}

/**
 * 连续调用超限时回给模型的拒绝理由。
 *
 * 必须讲清"等待"在 agent loop 里的实现方式：它不是一个可执行的动作，而是**不做
 * 动作**。编排者反复调用 `list_agents` 正是因为它想执行"等待"，而唯一看起来像
 * 等待的工具就是这个。
 * @param count - 已连续调用的次数。
 * @param limit - 允许的连续次数上限。
 * @returns 面向模型的拒绝文本。
 */
function denyReason(count: number, limit: number): string {
  return `You have called ${WATCHED_TOOL} ${count} times in a row (limit ${limit}). `
    + 'Waiting is not an action you perform — it is the absence of one. '
    + 'To wait for a background subagent, END YOUR RESPONSE NOW: emit one short sentence '
    + 'and call no tool at all. The runtime delivers the subagent\'s settlement notice on its '
    + 'own and that notice opens a fresh turn for you; nothing you call here can make it '
    + `arrive sooner. Calling ${WATCHED_TOOL} again only spends tokens. `
    + 'If a settlement notice or report already arrived in this conversation, act on it '
    + 'instead of polling.'
}

/** guard 注册所需的外部依赖。 */
export interface LoopGuardDeps {
  /** 允许的连续调用次数；超过即拒绝。 */
  readonly limit: () => number
}

/**
 * 注册循环卫生 guard：拦截对 {@link WATCHED_TOOL} 的连续调用。
 *
 * 用 `ctx.tools.guard()` 而非 `tools/pre-execute`：guard 是单调的，后续 waterfall
 * 监听器无法把拒绝变回许可。宿主自带的重复调用告警（"You are repeating the exact
 * same tool call"）只是提示，实测无法阻止循环。
 *
 * 计数只在**连续**调用上累积：任何其他工具调用都会清零，所以正常的「查一次状态、
 * 然后做别的事」不受影响。
 * @param ctx - 注册 guard 的上下文。
 * @param deps - 上限取值函数。
 * @returns 取消注册的 disposer。
 */
export function registerLoopGuard(ctx: Context, deps: LoopGuardDeps): () => void {
  const state: LoopGuardState = { perAgent: new WeakMap(), agentless: 0 }

  return ctx.tools.guard(execution => {
    const agent = execution.agent
    if (execution.name !== WATCHED_TOOL) {
      // 换了工具就不是在轮询了。清零而不是衰减：一次真实工作足以证明它在推进。
      if (agent === undefined) state.agentless = 0
      else state.perAgent.delete(agent)
      return undefined
    }
    const previous = agent === undefined ? state.agentless : state.perAgent.get(agent) ?? 0
    const count = previous + 1
    if (agent === undefined) state.agentless = count
    else state.perAgent.set(agent, count)
    const limit = deps.limit()
    return count > limit ? denyReason(count, limit) : undefined
  })
}
