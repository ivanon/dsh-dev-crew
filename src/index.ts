import type { Context } from '@deepseek-ai/cordis'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { CrewCoordinator } from './coordinator.ts'
import { registerCrewGate } from './gate.ts'
import { initDirs } from './init.ts'
import type { SkippedRoute } from './mount.ts'
import { registerCrewSettings } from './settings.ts'
import { registerCrewSkills } from './skills/index.ts'
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
export const inject = ['llm', 'tools', 'subagents', 'systemPrompt', 'skills']
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

  ctx.effect(() => registerCrewSkills(ctx))

  const runInit = () => initDirs(config.artifactDirs, process.cwd())

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'crew_init',
    description:
      'Create the crew workflow artifact directories (specs, plans, reports) in the current '
      + 'project. Idempotent: existing directories are left untouched and no file is ever '
      + 'overwritten. Call this before writing the first spec or plan if the directories are missing.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'array', items: { type: 'string' }, required: true },
          skipped: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.created.length === 0
          ? `All artifact directories already exist: ${value.skipped.join(', ')}`
          : `Created: ${value.created.join(', ')}${value.skipped.length === 0 ? '' : `; already present: ${value.skipped.join(', ')}`}`,
      }],
    },
    execute: async () => runInit(),
  })))

  // 'commands' 是可选服务：headless 部署没有命令适配器。ctx.get() 读取全局
  // 服务存储，不受拓扑限制；ctx.commands 属性代理未在 inject 中声明就读取
  // 会抛错，所以这里不能用它。
  ctx.get('commands')?.register({
    name: 'crew-init',
    description: 'Create the crew workflow artifact directories in this project.',
    handler: () => {
      const result = runInit()
      return {
        kind: 'success',
        text: result.created.length === 0
          ? `All artifact directories already exist: ${result.skipped.join(', ')}`
          : `Created: ${result.created.join(', ')}`,
      }
    },
  })

  // `config.gate.enabled` 只在挂载时决定是否注册 guard：中途开关需要重新
  // 注册/注销，那要在这一层（而非 registerCrewSettings 的 onChange 分支）
  // 处理。本任务不实现该分支——`enabled` 变更在下次插件重载后生效。
  if (config.gate.enabled) {
    ctx.effect(() => registerCrewGate(ctx, {
      // 精确匹配工具命名规则，不能用 startsWith('subagent_implementer')：
      // 那会把自定义角色 `implementer-v2` 的工具也当成 implementer。
      implementerToolNames: () => coordinator.mountedToolNames()
        .filter(name => name === 'subagent_implementer' || name.startsWith('subagent_implementer_')),
      options: () => ({ plansDir: current.gate.plansDir, cwd: process.cwd() }),
    }))
  }

  let current = config
  ctx.effect(() => registerCrewSettings(ctx, config, next => {
    current = next
    void coordinator.sync(current.roles)
  }))

  void coordinator.sync(current.roles)
  ctx.on('llm/adapters-updated', () => { void coordinator.sync(current.roles) })
}
