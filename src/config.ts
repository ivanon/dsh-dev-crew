import Schema from '@deepseek-ai/schemastery'
import type { Config as ConfigType, CrewRole } from './types.ts'

/**
 * 随包分发的三个职责角色。
 *
 * provider 与 model 留空、enabled 为 false：本包面向公开分发，作者本机的
 * provider 路由不存在于使用者机器上，内置具体路由会让每个新用户首次启动
 * 都产生一批不可用的工具。
 */
export const BUILTIN_ROLES: CrewRole[] = [
  {
    id: 'implementer',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You implement one task from an existing written plan. Read the plan file you are given, '
      + 'implement exactly the task you were assigned, and stop. Do not expand scope, do not '
      + 'redesign, and do not start work the plan assigns to another task. Report what you changed '
      + 'and how you verified it. '
      + 'When changing a file that already exists, use `edit` to replace the specific '
      + 'parts, one call per change. Do not rewrite a whole existing file with `write`: '
      + 'its output costs as many tokens as the file is long, and exceeding your '
      + 'single-response output limit truncates the turn silently. '
      + 'Put your complete conclusion in your FINAL message: only that message is '
      + 'delivered to the agent that started you, and the rest of your transcript is '
      + 'invisible to it — anything you write in an earlier message is lost. Never end '
      + 'with a bare acknowledgement like "done". You also have a `report` tool that '
      + 'delivers content at any point; use it when a partial finding changes what the '
      + 'delegating agent should do next, or when your conclusion is long enough that '
      + 'you would rather send it deliberately than rely on your last message.',
    // 移除委派工具：实现者不再向下分派。maxDepth 只限制深度而不限制扇出，
    // 直接移除工具更精确。
    toolFilter: { deny: ['subagent', 'subagent_fork'] },
  },
  {
    id: 'reviewer',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You review an artifact and report findings. You do not modify it: the delegating agent '
      + 'owns every fix. Separate blocking problems (errors, self-contradiction, missing content '
      + 'that would make a later step fail) from non-blocking ones (style, wording, polish), and '
      + 'state which is which. Report that you found nothing when you found nothing. '
      + 'The delegating agent gives you one review-file path; write your full findings '
      + 'there with the `write` tool, one section per finding, each stating whether it '
      + 'blocks and why. Write ONLY that file: never create, replace, or edit anything '
      + 'else — least of all the artifact under review. '
      + 'Then put a SHORT summary in your FINAL message: the review-file path, how many '
      + 'blocking and non-blocking findings you recorded, and one line naming each '
      + 'blocking one. The delegating agent decides convergence from that summary and '
      + 'reads your file when it needs the detail. '
      + 'Only that final message is delivered to it, and the rest of your transcript is '
      + 'invisible to it — a summary written in an earlier message is lost. Never end with '
      + 'a bare acknowledgement like "done". You also have a `report` tool that delivers '
      + 'content at any point; use it when a partial finding changes what the delegating '
      + 'agent should do next.',
    // `write` 放开是为了让 reviewer 自己把评审意见落盘：意见全文因此不必挤进
    // 「只有最后一条消息会被带回」这个通道，也不占编排者上下文。代价是工具级
    // 防护就此消失——`write` 的语义是 create or fully replace，能覆盖任何文件，
    // 而 `bash` 本来也在。产物不被改动这条纪律完全靠上面 persona 里的路径约定，
    // 以及 `crew-converge` 让编排者核对文件确实被创建。`edit` 仍拒：局部修改
    // 已有文件与「写一份新的评审报告」无关。
    toolFilter: { deny: ['edit', 'subagent', 'subagent_fork'] },
  },
  {
    id: 'researcher',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You investigate a question and report what you found, with sources. You do not modify the '
      + 'repository. Distinguish what you verified from what you inferred. '
      + 'Put your complete conclusion in your FINAL message: only that message is '
      + 'delivered to the agent that started you, and the rest of your transcript is '
      + 'invisible to it — anything you write in an earlier message is lost. Never end '
      + 'with a bare acknowledgement like "done". You also have a `report` tool that '
      + 'delivers content at any point; use it when a partial finding changes what the '
      + 'delegating agent should do next, or when your conclusion is long enough that '
      + 'you would rather send it deliberately than rely on your last message.',
    toolFilter: { deny: ['write', 'edit', 'subagent', 'subagent_fork'] },
  },
]

const RoleModelSchema = Schema.object({
  alias: Schema.string().default('default'),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxTokens: Schema.number(),
})

// 省略必须保持为 undefined。Schemastery 会把未提供的数组字段物化成 `[]`，
// 而 `allow: []` 的语义是「只保留这零个工具」——即移除全部工具，与「未配置
// 工具范围」的意图正好相反。
const ToolFilterSchema = Schema.object({
  allow: Schema.array(Schema.string()).default(undefined as unknown as string[]),
  deny: Schema.array(Schema.string()).default(undefined as unknown as string[]),
})

const CrewRoleSchema = Schema.object({
  id: Schema.string().required(),
  models: Schema.array(RoleModelSchema).default([]),
  persona: Schema.string(),
  toolFilter: ToolFilterSchema.default(undefined as unknown as { allow: string[]; deny: string[] }),
  enabled: Schema.boolean().default(false),
})

/**
 * `.default()` 的实参类型由 schema 自身推导，而不是我们手写的接口：这样
 * 转换目标会随 `CrewRoleSchema` 的字段变化自动更新，不会与之独立漂移。
 * Schemastery 把每个声明字段都变成推导输出类型里的必需键，即使我们自己
 * 的 `CrewRole`/`RoleModel` 接口把它标为可选（`persona?`、`toolFilter?`、
 * `maxTokens?`）；对 `BUILTIN_ROLES` 的转换记录的正是这个已知缺口，而不是
 * 掩盖它。
 */
type CrewRoleArrayOutput = Schemastery.TypeT<typeof CrewRoleSchema>[]

// The two Schema type parameters differ deliberately: input (first) leaves
// `roles` optional so `new Config({})` type-checks and falls back to
// BUILTIN_ROLES; output (second) is the plain `ConfigType`, where `roles` is
// always present after the schema fills in the default.
export const Config: Schema<Partial<ConfigType>, ConfigType> = Schema.object({
  roles: Schema.array(CrewRoleSchema).default(BUILTIN_ROLES as unknown as CrewRoleArrayOutput),
  gate: Schema.object({
    enabled: Schema.boolean().default(true),
    plansDir: Schema.string().default('docs/plans'),
  }).default({ enabled: true, plansDir: 'docs/plans' }),
  artifactDirs: Schema.array(Schema.string()).default([
    'docs/specs',
    'docs/plans',
    'docs/reviews',
    'docs/reports',
  ]),
  pipeline: Schema.object({
    maxConvergenceRounds: Schema.number().min(1).max(10).default(3),
  }).default({ maxConvergenceRounds: 3 }),
})
