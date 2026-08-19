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
      + 'and how you verified it.',
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
      + 'state which is which. Report that you found nothing when you found nothing.',
    toolFilter: { deny: ['write', 'edit', 'str_replace_editor', 'subagent', 'subagent_fork'] },
  },
  {
    id: 'researcher',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You investigate a question and report what you found, with sources. You do not modify the '
      + 'repository. Distinguish what you verified from what you inferred.',
    toolFilter: { deny: ['write', 'edit', 'str_replace_editor', 'subagent', 'subagent_fork'] },
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
  artifactDirs: Schema.array(Schema.string()).default(['docs/specs', 'docs/plans', 'docs/reports']),
  pipeline: Schema.object({
    maxConvergenceRounds: Schema.number().min(1).max(10).default(3),
  }).default({ maxConvergenceRounds: 3 }),
})
