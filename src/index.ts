import type { Context } from '@deepseek-ai/cordis'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject，运行时抛
// 「cannot get property "subagents" without inject」。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { Config } from './config.ts'
import { planMounts } from './mount.ts'
import type { Config as ConfigType } from './types.ts'

export const name = 'dsh-dev-crew'
export const inject = ['llm', 'tools', 'subagents']
export { Config }

export function apply(ctx: Context, config: ConfigType): void {
  const plan = planMounts(
    config.roles,
    ctx.llm.listProviders(),
    ctx.llm.listConfigurableProviders(),
  )

  for (const spec of plan.specs) {
    ctx.plugin(subagentTool, spec.config)
  }

  for (const entry of plan.skipped) {
    const advice = entry.reason === 'unconfigured'
      ? `provider "${entry.provider}" is declared but not configured; configure it on the Models settings page`
      : `provider "${entry.provider}" is not registered by any adapter`
    ctx.logger('dsh-dev-crew').warn(`${entry.toolName} not mounted: ${advice}`)
  }
}
