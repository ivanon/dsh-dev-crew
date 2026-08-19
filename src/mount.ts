import type { ConfigurableProvider, LiveProvider, RouteHealth } from './health.ts'
import { checkRoute } from './health.ts'
import type { CrewRole, RoleModel, ToolFilter } from './types.ts'

/**
 * 传给 `@deepseek-ai/dsh-tool-subagent` 的配置。
 *
 * `provider` 固定为 `spawn`：fork 的前缀复用收益会被 continuable 子代理装入
 * 请求头部的 report 工具与提示词段落抵消，付出复制历史的成本而收益归零。
 */
export interface SubagentToolConfig {
  provider: 'spawn'
  toolName: string
  backgroundMode: 'continuable'
  agentOptions: { provider: string; model: string; maxTokens?: number }
  persona?: string
  toolFilter?: ToolFilter
}

/** 一个待挂载的委派工具实例。 */
export interface MountSpec {
  toolName: string
  config: SubagentToolConfig
}

/** 一个因路由不可用而未挂载的工具实例。 */
export interface SkippedRoute {
  toolName: string
  provider: string
  reason: RouteHealth
}

/** 一次挂载推导的完整结果。 */
export interface MountPlan {
  specs: MountSpec[]
  skipped: SkippedRoute[]
}

/**
 * 推导一个模型条目对应的工具名。
 * @param role - 该模型所属的角色。
 * @param model - 模型条目。
 * @returns 单模型角色为 `subagent_<role>`，多模型角色为 `subagent_<role>_<alias>`。
 */
export function toolNameFor(role: CrewRole, model: RoleModel): string {
  return role.models.length === 1
    ? `subagent_${role.id}`
    : `subagent_${role.id}_${model.alias}`
}

/**
 * 推导挂载计划：哪些工具该挂，哪些因路由不可用被跳过。
 *
 * 停用的角色既不挂载也不记入 skipped —— 那是用户的选择，不是配置问题。
 * @param roles - 配置中的角色列表。
 * @param live - 当前已注册的 provider 路由。
 * @param configurable - 已声明可通过配置激活的 provider 路由。
 * @returns 待挂载实例与被跳过实例。
 */
export function planMounts(
  roles: readonly CrewRole[],
  live: readonly LiveProvider[],
  configurable: readonly ConfigurableProvider[],
): MountPlan {
  const specs: MountSpec[] = []
  const skipped: SkippedRoute[] = []

  for (const role of roles) {
    if (!role.enabled) continue
    for (const model of role.models) {
      const toolName = toolNameFor(role, model)
      const health = checkRoute(model.provider, live, configurable)
      if (health !== 'ready') {
        skipped.push({ toolName, provider: model.provider, reason: health })
        continue
      }
      specs.push({
        toolName,
        config: {
          provider: 'spawn',
          toolName,
          backgroundMode: 'continuable',
          agentOptions: {
            provider: model.provider,
            model: model.model,
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          },
          ...role.persona === undefined ? {} : { persona: role.persona },
          ...role.toolFilter === undefined ? {} : { toolFilter: role.toolFilter },
        },
      })
    }
  }

  return { specs, skipped }
}
