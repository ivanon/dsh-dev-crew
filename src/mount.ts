import type { Config as SubagentPluginConfig } from '@deepseek-ai/dsh-tool-subagent'
import { BUILTIN_ROLES } from './config.ts'
import type { ConfigurableProvider, LiveProvider, RouteHealth } from './health.ts'
import { checkRoute } from './health.ts'
import type { CrewRole, RoleModel, ToolFilter } from './types.ts'

/**
 * 传给 `@deepseek-ai/dsh-tool-subagent` 的配置。
 *
 * 字段类型取自上游 `Config` 而非手抄：`ctx.plugin(plugin, config)` 的第二参是
 * `any`，上游删名或改名不会在调用处报错，`Pick` 会在此处先编译失败。
 *
 * `provider` 固定为 `spawn`：fork 的前缀复用收益会被 continuable 子代理装入
 * 请求头部的 report 工具与提示词段落抵消，付出复制历史的成本而收益归零。
 */
export interface SubagentToolConfig extends
  Required<Pick<SubagentPluginConfig, 'provider' | 'toolName' | 'backgroundMode' | 'agentOptions'>>,
  Pick<SubagentPluginConfig, 'persona' | 'toolFilter'> {
  provider: 'spawn'
  backgroundMode: 'continuable'
  agentOptions: { provider: string; model: string; maxTokens?: number }
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

/** 第一遍认定为路由就绪的实例：工具名已定，配置尚未构造。 */
interface ReadyMount {
  role: CrewRole
  model: RoleModel
  toolName: string
}

/**
 * 把本次实际挂上的其他 crew 工具名并入一个角色的 deny 列表。
 *
 * 原有条目在前、其他 crew 工具名按挂载顺序在后，去重后顺序稳定：`diffMounts`
 * 用 `JSON.stringify` 判等，不稳定的顺序会把未变化的实例判成需要重挂。
 * @param toolFilter - 该角色已有的工具范围（用户提供的或内置填充来的）。
 * @param others - 本次挂载的其他 crew 工具名。
 * @returns 合并后的工具范围；无需注入且原本没有工具范围时返回 undefined。
 */
function denyOtherCrewTools(
  toolFilter: ToolFilter | undefined,
  others: readonly string[],
): ToolFilter | undefined {
  if (others.length === 0) return toolFilter
  return { ...toolFilter, deny: [...new Set([...toolFilter?.deny ?? [], ...others])] }
}

/**
 * 推导挂载计划：哪些工具该挂，哪些因路由不可用被跳过。
 *
 * 停用的角色既不挂载也不记入 skipped —— 那是用户的选择，不是配置问题。
 *
 * 内置模板填充：`id` 命中 {@link BUILTIN_ROLES} 的角色，其未提供的 `persona` 与
 * `toolFilter` 取自同 id 的内置定义。填充必须发生在这里，因为 schema 里 `roles`
 * 数组的默认值是整体替换而非按 id 合并：用户在 profile patch 中只写 `id` +
 * `models` + `enabled` 时，内置角色写好的 persona 与工具范围不会进入配置对象。
 * 用户显式提供的值整体优先，不与内置值深合并；非内置 id 不做任何填充。
 *
 * 互斥 deny：每个实例的 `toolFilter.deny` 追加本次实际挂上的其他 crew 工具名，
 * 使子代理看不到本插件挂出的委派工具。只有真正挂上的名字可以写入 —— 上游用
 * `ctx.tools.restrict()` 应用过滤，未注册的工具名会让挂载失败 —— 所以推导分两遍：
 * 先定下就绪集合，再据此构造配置。
 *
 * 互斥 deny 的级联代价：`deny` 列表由「本次调用里的其他就绪角色」推导，因此只要
 * 就绪集合新增（或移除）一个角色，除该角色自身外，**全部既有就绪角色的
 * `toolFilter.deny` 都会随之变化**——即使它们的 provider、model、persona 都没有
 * 变化。调用方（`CrewCoordinator`）按 `config` 的 `JSON.stringify` 判等来决定是
 * 否重挂载，deny 列表变化即被判定为「配置变了」，于是全部既有角色的委派工具都
 * 会被卸载重挂一次，每次重挂都让该工具对应的模型请求前缀缓存失效一次。这是
 * 「子代理必须看不到其他委派工具」这条需求的自然代价，不是缺陷；但意味着启用或
 * 停用单个角色从来不是局部变更——它牵连当前全部就绪角色。
 * @param roles - 配置中的角色列表。
 * @param live - 当前已注册的 provider 路由。
 * @param configurable - 已声明可通过配置激活的 provider 路由。
 * @returns 待挂载实例与被跳过实例。
 * @throws Error 两个实例推导出同一个工具名时。重名会让第二次挂载失败，而协调器的
 *   记录被后者覆盖，第一个实例的 dispose 句柄就此丢失、工具永久泄漏；配置错误在
 *   最早可解析处大声失败，好过挂上一个卸不掉的工具。
 */
export function planMounts(
  roles: readonly CrewRole[],
  live: readonly LiveProvider[],
  configurable: readonly ConfigurableProvider[],
): MountPlan {
  const ready: ReadyMount[] = []
  const skipped: SkippedRoute[] = []
  const origins = new Map<string, string>()

  for (const role of roles) {
    if (!role.enabled) continue
    for (const model of role.models) {
      const toolName = toolNameFor(role, model)
      const origin = `role "${role.id}" alias "${model.alias}"`
      const previous = origins.get(toolName)
      if (previous !== undefined) {
        throw new Error(
          `dsh-dev-crew: ${origin} and ${previous} both resolve to the delegation tool `
          + `"${toolName}"; role ids must be unique and aliases must be unique within a role`,
        )
      }
      origins.set(toolName, origin)

      const health = checkRoute(model.provider, live, configurable)
      if (health !== 'ready') {
        skipped.push({ toolName, provider: model.provider, reason: health })
        continue
      }
      ready.push({ role, model, toolName })
    }
  }

  const builtins = new Map(BUILTIN_ROLES.map(builtin => [builtin.id, builtin]))
  const specs = ready.map(({ role, model, toolName }): MountSpec => {
    const builtin = builtins.get(role.id)
    const persona = role.persona ?? builtin?.persona
    const toolFilter = denyOtherCrewTools(
      role.toolFilter ?? builtin?.toolFilter,
      ready.map(entry => entry.toolName).filter(name => name !== toolName),
    )
    return {
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
        ...persona === undefined ? {} : { persona },
        ...toolFilter === undefined ? {} : { toolFilter },
      },
    }
  })

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
