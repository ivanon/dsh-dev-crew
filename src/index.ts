import type { Context } from '@deepseek-ai/cordis'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { Config } from './config.ts'
import { CrewCoordinator } from './coordinator.ts'
import { registerCrewGate } from './gate.ts'
import type { SkippedRoute } from './mount.ts'
import type { Config as ConfigType } from './types.ts'

export const name = 'dsh-dev-crew'
// 'systemPrompt' 不是本插件自己调用的服务：它是 apply() 内部
// ctx.plugin(subagentTool, ...) 挂载的委派工具的依赖（@deepseek-ai/dsh-tool-subagent
// 的运行时 inject 是 ['tools', 'subagents', 'systemPrompt']）。cordis 的 inject
// 逐插件静态声明，不会从子插件的依赖反向推导；若宿主没组合 systemPrompt，缺了这一项
// 会让内部子 fiber 静默卡在 PENDING（不报错、不记日志、协调器仍把它记成已挂载），
// 而本插件自己却正常变成 ACTIVE。声明在这里，缺失时停在 PENDING 的是
// dsh-dev-crew 这一行，用户能在自己直接挂载的地方看到状态。清理未使用的 inject 时
// 不要删掉它。
export const inject = ['llm', 'tools', 'subagents', 'systemPrompt']
export { Config }

/** 把一条被跳过的路由渲染成可操作的说明。 */
function adviseSkipped(entry: SkippedRoute): string {
  if (entry.provider === '') {
    return `${entry.toolName} not mounted: this role has no provider configured`
  }
  return entry.reason === 'unconfigured'
    ? `${entry.toolName} not mounted: provider "${entry.provider}" is declared but not configured; configure it on the Models settings page`
    : `${entry.toolName} not mounted: provider "${entry.provider}" is not registered by any adapter`
}

export function apply(ctx: Context, config: ConfigType): void {
  const logger = ctx.logger('dsh-dev-crew')
  let lastSkippedKey = ''
  // 保留最近一次的跳过清单：阶段三的健康查询路由要读它，补上 headless 下
  // logger 输出不可见留下的可观测性缺口。
  let lastSkipped: readonly SkippedRoute[] = []

  const coordinator = new CrewCoordinator({
    mount: async spec => {
      const fiber = ctx.plugin(subagentTool, spec.config satisfies subagentTool.Config)
      return async () => { await fiber.dispose() }
    },
    readProviders: () => ({
      live: ctx.llm.listProviders(),
      configurable: ctx.llm.listConfigurableProviders(),
    }),
    onSkipped: skipped => {
      lastSkipped = skipped
      // 拓扑通知在启动阶段连续到达；仅在跳过集合真正变化时输出。
      const key = JSON.stringify(skipped)
      if (key === lastSkippedKey) return
      lastSkippedKey = key
      for (const entry of skipped) logger.warn(adviseSkipped(entry))
    },
    onError: error => { logger.error(error) },
  })

  ctx.effect(() => () => { void coordinator.dispose() })

  if (config.gate.enabled) {
    ctx.effect(() => registerCrewGate(ctx, {
      // 精确匹配工具命名规则，不能用 startsWith('subagent_implementer')：
      // 那会把自定义角色 `implementer-v2` 的工具也当成 implementer。
      implementerToolNames: () => coordinator.mountedToolNames()
        .filter(name => name === 'subagent_implementer' || name.startsWith('subagent_implementer_')),
      options: () => ({ plansDir: config.gate.plansDir, cwd: process.cwd() }),
    }))
  }

  void coordinator.sync(config.roles)
  ctx.on('llm/adapters-updated', () => { void coordinator.sync(config.roles) })
}
