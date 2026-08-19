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

const ToolFilterSchema = Schema.object({
  allow: Schema.array(Schema.string()),
  deny: Schema.array(Schema.string()),
})

const CrewRoleSchema = Schema.object({
  id: Schema.string().required(),
  models: Schema.array(RoleModelSchema).default([]),
  persona: Schema.string(),
  toolFilter: ToolFilterSchema,
  enabled: Schema.boolean().default(false),
})

/**
 * The exact literal shape `Schema.array(CrewRoleSchema).default()` requires:
 * every declared object-schema field becomes a required key in Schemastery's
 * inferred output type, even for fields our own `CrewRole`/`RoleModel`
 * interfaces mark optional (`persona?`, `toolFilter?`, `maxTokens?`). Casting
 * `BUILTIN_ROLES` to this shape documents that gap instead of hiding it.
 */
type BuiltinRolesDefault = {
  id: string
  models: { alias: string; provider: string; model: string; maxTokens: number }[]
  persona: string
  toolFilter: { allow: string[]; deny: string[] }
  enabled: boolean
}[]

// The two Schema type parameters differ deliberately: input (first) leaves
// `roles` optional so `new Config({})` type-checks and falls back to
// BUILTIN_ROLES; output (second) is the plain `ConfigType`, where `roles` is
// always present after the schema fills in the default.
export const Config: Schema<Partial<ConfigType>, ConfigType> = Schema.object({
  roles: Schema.array(CrewRoleSchema).default(BUILTIN_ROLES as unknown as BuiltinRolesDefault),
})
