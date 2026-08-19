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

/** 两次挂载计划之间的差异。 */
export interface MountDiff {
  /** 需要新挂载的实例。 */
  toAdd: MountSpec[]
  /** 需要卸载的实例工具名。 */
  toRemove: string[]
}

/**
 * 比较当前已挂载的实例与新的挂载计划。
 *
 * 配置变化的实例出现在两侧：委派工具的路由绑定在挂载时固定，改变它必须重新
 * 挂载，没有原地更新的途径。
 * @param current - 当前已挂载的实例。
 * @param next - 新推导出的挂载计划。
 * @returns 待新增与待卸载的实例。
 */
export function diffMounts(
  current: readonly MountSpec[],
  next: readonly MountSpec[],
): MountDiff {
  const currentByName = new Map(current.map(spec => [spec.toolName, spec]))
  const nextByName = new Map(next.map(spec => [spec.toolName, spec]))

  const toAdd: MountSpec[] = []
  const toRemove: string[] = []

  for (const spec of current) {
    const replacement = nextByName.get(spec.toolName)
    if (replacement === undefined) toRemove.push(spec.toolName)
    else if (JSON.stringify(replacement.config) !== JSON.stringify(spec.config)) {
      toRemove.push(spec.toolName)
    }
  }

  for (const spec of next) {
    const existing = currentByName.get(spec.toolName)
    if (existing === undefined) toAdd.push(spec)
    else if (JSON.stringify(existing.config) !== JSON.stringify(spec.config)) {
      toAdd.push(spec)
    }
  }

  return { toAdd, toRemove }
}
