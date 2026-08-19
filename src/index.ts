import type { Context } from '@deepseek-ai/cordis'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject，运行时抛
// 「cannot get property "subagents" without inject」。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { Config } from './config.ts'
import type { MountSpec } from './mount.ts'
import { diffMounts, planMounts } from './mount.ts'
import type { Config as ConfigType } from './types.ts'

export const name = 'dsh-dev-crew'
export const inject = ['llm', 'tools', 'subagents']
export { Config }

/** 一个已挂载的委派工具实例及其可卸载的 fiber。 */
interface MountedEntry {
  spec: MountSpec
  dispose: () => Promise<void>
}

export function apply(ctx: Context, config: ConfigType): void {
  const logger = ctx.logger('dsh-dev-crew')
  const mounted = new Map<string, MountedEntry>()
  let lastSkippedKey = ''

  // 串行化：两次拓扑通知紧邻到达时，第二次必须看到第一次的挂载结果，
  // 否则会重复挂载同一个工具名。
  let queue: Promise<void> = Promise.resolve()

  const runSync = async (): Promise<void> => {
    const plan = planMounts(
      config.roles,
      ctx.llm.listProviders(),
      ctx.llm.listConfigurableProviders(),
    )
    const diff = diffMounts([...mounted.values()].map(entry => entry.spec), plan.specs)

    for (const toolName of diff.toRemove) {
      const entry = mounted.get(toolName)
      if (entry === undefined) continue
      mounted.delete(toolName)
      await entry.dispose()
    }

    for (const spec of diff.toAdd) {
      const fiber = ctx.plugin(subagentTool, spec.config)
      mounted.set(spec.toolName, { spec, dispose: async () => { await fiber.dispose() } })
    }

    // 拓扑通知在启动阶段会连续到达多次；仅在跳过集合真正变化时输出，
    // 否则同一条配置错误会重复刷屏。
    const skippedKey = JSON.stringify(plan.skipped)
    if (skippedKey !== lastSkippedKey) {
      lastSkippedKey = skippedKey
      for (const entry of plan.skipped) {
        const advice = entry.reason === 'unconfigured'
          ? `provider "${entry.provider}" is declared but not configured; configure it on the Models settings page`
          : `provider "${entry.provider}" is not registered by any adapter`
        logger.warn(`${entry.toolName} not mounted: ${advice}`)
      }
    }
  }

  const sync = (): Promise<void> => {
    queue = queue.then(runSync, runSync)
    return queue
  }

  void sync()
  ctx.on('llm/adapters-updated', () => { void sync() })
}
