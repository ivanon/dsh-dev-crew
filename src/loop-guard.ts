// 与 gate.ts 同一个理由用同步裸逻辑：ToolGuard 的签名是
// `(execution) => string | undefined`，无法 await。这条判据只读内存里的计数，
// 不触碰文件系统或网络。
import type { Context } from '@deepseek-ai/cordis'

/**
 * 状态查询工具名。
 *
 * `list_agents` 是编排者唯一能用来"查看子代理状态"的工具，因此也是它唯一能用来
 * 假装自己在等待的工具。真实会话里编排者连续调用它 149 次、单次会话累计 1220 次
 * （占全部工具调用的 89%），两次把用户的模型额度耗尽（403 usage limit）；期间
 * 子代理的回报消息已经到达，却没能打断这个循环。
 */
const LISTING_TOOL = 'list_agents'

/**
 * 提问工具名。
 *
 * 它会阻塞等待用户输入，因此在编排者眼里最像"等待"。真实会话里编排者派出
 * reviewer 之后先跑了一次 `bash echo "waiting"`（description 自陈
 * "Placeholder while waiting for reviewer"），紧接着用一个空问题调用它：
 * `{id:"placeholder", header:"Wait", question:"This is a placeholder", options:[]}`。
 * 流水线就此卡在一个无法有意义回答的选择框上。
 */
const ASK_TOOL = 'ask_user_question'

/** 每个 Agent 最近一次经过 guard 的工具，以及它连续出现的次数。 */
interface Streak {
  tool: string
  count: number
}

/** 一个 Agent 的 guard 状态。 */
interface AgentState {
  streak: Streak
  /**
   * 已派出角色子代理、尚未做任何实质工作。
   *
   * 这是"等待期"的判据。派发角色工具置位；`list_agents` 与 {@link ASK_TOOL} 都不
   * 清除它（它们不是工作，正是编排者用来假装等待的两个工具）；任何其他工具调用
   * 清除它——读文件、改文件、跑命令都说明它已经在处理回报而不是在等。
   */
  awaitingDispatch: boolean
}

/**
 * 轮询超限的拒绝理由。
 *
 * 必须讲清"等待"在 agent loop 里的实现方式：它不是一个可执行的动作，而是**不做
 * 动作**。编排者反复调用 `list_agents` 正是因为它想执行"等待"，而唯一看起来像
 * 等待的工具就是这个。
 * @param count - 已连续调用的次数。
 * @param limit - 允许的连续次数上限。
 * @returns 面向模型的拒绝文本。
 */
function denyPolling(count: number, limit: number): string {
  return `You have called ${LISTING_TOOL} ${count} times in a row (limit ${limit}). `
    + 'Waiting is not an action you perform — it is the absence of one. '
    + 'To wait for a background subagent, END YOUR RESPONSE NOW: emit one short sentence '
    + 'and call no tool at all. The runtime delivers the subagent\'s settlement notice on its '
    + 'own and that notice opens a fresh turn for you; nothing you call here can make it '
    + `arrive sooner. Calling ${LISTING_TOOL} again only spends tokens. `
    + 'If a settlement notice or report already arrived in this conversation, act on it '
    + 'instead of polling.'
}

/**
 * 重复派发同一 reviewer 的拒绝理由。
 *
 * 真实会话里编排者用两段不同的 prompt 把同一个 `subagent_reviewer` 派了两次，
 * 自称"第二视角"，并把两份评审文件分别命名为 `..._r1-subagent_reviewer.md` 与
 * `..._r1-subagent_reviewer_2.md`。两次跑的是同一个 provider 与 model，不构成
 * 独立视角，只是把一个评审环节的成本翻倍。
 * @param tool - 被重复派发的 reviewer 工具名。
 * @returns 面向模型的拒绝文本。
 */
function denyDuplicateReviewer(tool: string): string {
  return `You already dispatched ${tool} for this review round. `
    + 'One review round uses each reviewer tool exactly once. Dispatching the same tool again '
    + 'with a different prompt does NOT create an independent perspective: it is the same '
    + 'provider and model, so it only doubles the cost of this round. '
    + `Its conclusion arrives on its own — end your response and wait. `
    + 'To re-review after a fix, use send_message to that same subagent rather than dispatching '
    + 'a new one. If this deployment genuinely needs several perspectives, its operator '
    + 'configures more than one model on the reviewer role, which mounts one tool per model.'
}

/**
 * 等待期内提问的拒绝理由。
 *
 * 第四种假等待形态，也是最难拦的一种：问题带着两个像样的选项（"继续等待" /
 * "中止流水线"），既不是空列表，也不与前一次调用相邻。真实会话里编排者在同一个
 * turn 里问了四次「子代理长时间未返回，你希望继续等待还是中止？」，把等待责任推给
 * 用户，而流水线的承诺是规格落盘后零打扰。
 * @param tool - 触发等待期的角色工具名。
 * @returns 面向模型的拒绝文本。
 */
function denyAskWhileWaiting(tool: string): string {
  return `You dispatched ${tool} and have done no work since; you are in the waiting phase. `
    + 'Asking the user anything here hands them your job: they cannot make the subagent finish '
    + 'sooner, and this pipeline promises no interruptions between the spec landing and the '
    + 'final report. A subagent taking a long time is not a decision point — it is the normal '
    + 'case. END YOUR RESPONSE NOW: one sentence naming what you dispatched, no tool call. '
    + 'The runtime wakes you when it settles. If you genuinely believe the subagent is dead, '
    + 'check list_agents once: `running` means keep waiting, and anything else has a defined '
    + 'handling in the convergence protocol that does not involve asking the user.'
}

/**
 * 空问题的拒绝理由。
 *
 * `options: []` 语义上是"这里有一份选项列表，但列表是空的"——无效调用。真正需要
 * 自由输入的问题应当**省略** `options`。空列表几乎只出现在一种场合：编排者想执行
 * "等待"，而这个工具是它能找到的最像等待的动作。
 * @returns 面向模型的拒绝文本。
 */
function denyEmptyQuestion(): string {
  return `A question in this ${ASK_TOOL} call has an empty options list. `
    + 'An empty list means "here is a list of choices" and then offers none; omit `options` '
    + 'entirely when the answer must be free text. '
    + 'If you called this to wait for a background subagent: waiting is not an action. '
    + 'END YOUR RESPONSE NOW — emit one sentence naming what you dispatched and what you are '
    + 'waiting for, and call no tool at all. That sentence ends your turn; the runtime wakes '
    + 'you when the subagent settles. A placeholder question, a `bash echo`, or any other '
    + 'filler call does not wait — it only spends tokens and, in this tool\'s case, blocks the '
    + 'pipeline on a prompt the user cannot meaningfully answer.'
}

/** guard 注册所需的外部依赖。 */
export interface LoopGuardDeps {
  /** `list_agents` 允许的连续调用次数；超过即拒绝。 */
  readonly listingLimit: () => number
  /**
   * 当前挂载的**全部**角色工具名（implementer / reviewer / researcher，含 alias 后缀）。
   *
   * 用于判定"等待期"：任何一个被调用即置位，之后到做出实质工作之前不允许提问。
   */
  readonly roleToolNames: () => readonly string[]
  /**
   * 当前挂载的 reviewer 角色工具名。
   *
   * 每个名字在一个评审环节里只允许派发一次。判据是**连续**派发：中间夹了任何其他
   * 工具调用就说明环节已经推进（例如 spec 评审之后写计划、再派 plan 评审），计数
   * 清零，跨环节的正常派发不受影响。
   */
  readonly reviewerToolNames: () => readonly string[]
}

/**
 * 注册循环卫生 guard。
 *
 * 拦截三种病态调用：对 {@link LISTING_TOOL} 的连续轮询、同一 reviewer 工具的连续
 * 重复派发，以及 {@link ASK_TOOL} 的空选项问题。三者都是编排者"假装自己在做事"的
 * 形态——前两种烧 token，第三种还会把流水线卡在一个无法回答的提示上。
 *
 * 用 `ctx.tools.guard()` 而非 `tools/pre-execute`：guard 是单调的，后续 waterfall
 * 监听器无法把拒绝变回许可。宿主自带的重复调用告警（"You are repeating the exact
 * same tool call"）只是提示，实测无法阻止循环。
 * @param ctx - 注册 guard 的上下文。
 * @param deps - 上限与 reviewer 工具名的取值函数。
 * @returns 取消注册的 disposer。
 */
export function registerLoopGuard(ctx: Context, deps: LoopGuardDeps): () => void {
  const perAgent = new WeakMap<object, AgentState>()
  let agentless: AgentState = { streak: { tool: '', count: 0 }, awaitingDispatch: false }

  return ctx.tools.guard(execution => {
    const agent = execution.agent
    const previous = agent === undefined ? agentless : perAgent.get(agent)
    const streak: Streak = previous?.streak.tool === execution.name
      ? { tool: execution.name, count: previous.streak.count + 1 }
      // 换了工具就不是在重复了。重置为 1 而不是累加：一次别的调用足以证明它在推进。
      : { tool: execution.name, count: 1 }
    const dispatched = deps.roleToolNames().includes(execution.name)
    const idle = execution.name === LISTING_TOOL || execution.name === ASK_TOOL
    const awaitingDispatch = dispatched ? true : idle ? previous?.awaitingDispatch === true : false
    const state: AgentState = { streak, awaitingDispatch }
    if (agent === undefined) agentless = state
    else perAgent.set(agent, state)

    if (execution.name === ASK_TOOL) {
      // 先判等待期：它比空列表更常见，且拒绝理由更贴近当下该做的事。
      if (previous?.awaitingDispatch === true) return denyAskWhileWaiting(previous.streak.tool)
      const args = execution.arguments as { questions?: readonly { options?: readonly unknown[] }[] }
      // 只看显式给出的空列表；省略 `options` 是合法的自由输入题。
      const empty = args.questions?.some(q => q.options !== undefined && q.options.length === 0)
      return empty === true ? denyEmptyQuestion() : undefined
    }

    if (execution.name === LISTING_TOOL) {
      const limit = deps.listingLimit()
      return streak.count > limit ? denyPolling(streak.count, limit) : undefined
    }
    if (streak.count > 1 && deps.reviewerToolNames().includes(execution.name)) {
      return denyDuplicateReviewer(execution.name)
    }
    return undefined
  })
}
