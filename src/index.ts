import type { Context } from '@deepseek-ai/cordis'
import type { Config as SubagentPluginConfig } from '@deepseek-ai/dsh-tool-subagent'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject，运行时抛
// 「cannot get property "subagents" without inject」。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { Config } from './config.ts'
import type { MountSpec, SkippedRoute } from './mount.ts'
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

/**
 * 说明一个实例为何没有挂载。
 * @param entry - 被跳过的实例。
 * @returns 面向用户的一句修复指引。
 */
function adviseSkipped(entry: SkippedRoute): string {
  if (entry.provider === '') return 'the role has no provider configured; set provider on its model entry'
  return entry.reason === 'unconfigured'
    ? `provider "${entry.provider}" is declared but not configured; configure it on the Models settings page`
    : `provider "${entry.provider}" is not registered by any adapter`
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
      // satisfies 补上 ctx.plugin 第二参的 any：上游 Config 新增必填字段或收紧
      // 已有字段时在此编译失败，而不是留到运行时被 fiber 吞掉。
      const fiber = ctx.plugin(subagentTool, spec.config satisfies SubagentPluginConfig)
      mounted.set(spec.toolName, { spec, dispose: async () => { await fiber.dispose() } })
    }

    // 拓扑通知在启动阶段会连续到达多次；仅在跳过集合真正变化时输出，
    // 否则同一条配置错误会重复刷屏。
    const skippedKey = JSON.stringify(plan.skipped)
    if (skippedKey !== lastSkippedKey) {
      lastSkippedKey = skippedKey
      for (const entry of plan.skipped) {
        logger.warn(`${entry.toolName} not mounted: ${adviseSkipped(entry)}`)
      }
    }
  }

  // 队列必须吸收 runSync 的失败：queue 悬在 fiber 之外，一个无 handler 的被拒
  // promise 会以 Node 默认的 --unhandled-rejections=throw 终止宿主进程。这条路径
  // 可达 —— 本 fiber 已 dispose 时 ctx.plugin() 同步抛 INACTIVE_EFFECT，而
  // llm/adapters-updated 正是在 provider 注册被 dispose 时发布的。协调器状态不会
  // 因此错位：mounted 只在 ctx.plugin() 返回后写入，卸载则先删记录再 dispose，
  // 失败留下的是「未挂上也未记录」，下一次 sync 会重新推导补齐。
  const runSyncLogged = async (): Promise<void> => {
    try {
      await runSync()
    }
    catch (error) {
      logger.error(error)
    }
  }

  // runSyncLogged 不会拒绝，因此 queue 恒为兑现态，无需再挂拒绝处理器。
  const sync = (): Promise<void> => {
    queue = queue.then(runSyncLogged)
    return queue
  }

  void sync()
  ctx.on('llm/adapters-updated', () => { void sync() })
}
