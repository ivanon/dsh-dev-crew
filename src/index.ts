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
export const inject = ['llm', 'tools', 'subagents']
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
