import type { Context } from '@deepseek-ai/cordis'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { CrewCoordinator } from './coordinator.ts'
import { registerCrewGate } from './gate.ts'
import { registerLoopGuard } from './loop-guard.ts'
import { registerCrewApi } from './http.ts'
import { initDirs } from './init.ts'
import type { SkippedRoute } from './mount.ts'
import { registerCrewSettings, SETTINGS_NAMESPACE } from './settings.ts'
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

  // 'commands'、下面的 'settings'、'webServer' 都是可选服务：headless 等部署不
  // 组合它们。三处都要注册一个需要长期有效的效果（命令/设置监听/HTTP 路由），
  // 不能只用 `ctx.get(name)` 在 apply() 执行的那一刻判断"有没有"就决定要不要
  // 注册——`ctx.get()` 分不清"服务不存在"和"服务还没加载完"：cordis 对没有共享
  // `inject` 关系的两个 entry 不提供任何同步顺序保证，服务只是碰巧还没轮到自己
  // 的 fiber 完成注册时，一次性快照会把它误判成"不存在"，此后永远错过，且没有
  // 任何报错（这不是假设，是在真实组合了 Web host 的 profile 上实测复现过的
  // bug）。正确做法是 `ctx.inject(deps, callback)`：它是 `ctx.plugin({ inject:
  // deps, apply: callback })` 的简写，创建一个子插件——依赖未就绪时停在 PENDING
  // 的是这个子插件而不是 dsh-dev-crew 本体，依赖就绪后自动执行，服务消失时
  // （若之后又被卸载）子 fiber 也会正确回收，没有竞态。
  //
  // 这与 dsh 包规范里"可选服务用 `ctx.get(name)`"并不矛盾：那条规范针对的是
  // "读取一次服务实例的当前值"这个动作（比如懒读取、每次调用都重新判断——见下面
  // `webServer` 块里 `hctx.get('settings')` 的用法）；这里做的是"注册一个必须在
  // 服务生命周期内保持有效的效果"，对加载时序的要求不同，只看那条规范会误以为
  // `ctx.get()` 就够用。
  //
  // 顶层 `inject` 数组不能直接写 `commands`/`settings`/`webServer`：那样会让
  // 整个 dsh-dev-crew 插件在不组合这些服务的部署（例如 headless）下永久
  // PENDING，而不是只有这一小段可选功能不可用。
  ctx.inject(['commands'], cctx => {
    cctx.effect(() => cctx.get('commands')?.register({
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
    }))
  })

  let current = config

  // `config.gate.enabled` 只在挂载时决定是否注册 guard：中途开关需要重新
  // 注册/注销，那要在这一层（而非 registerCrewSettings 的 onChange 分支）
  // 处理。本任务不实现该分支——`enabled` 变更在下次插件重载后生效。
  if (config.gate.enabled) {
    ctx.effect(() => registerCrewGate(ctx, {
      // 精确匹配工具命名规则，不能用 startsWith('subagent_implementer')：
      // 那会把自定义角色 `implementer-v2` 的工具也当成 implementer。
      implementerToolNames: () => coordinator.mountedToolNames()
        .filter(name => name === 'subagent_implementer' || name.startsWith('subagent_implementer_')),
      plansDir: () => current.gate.plansDir,
      fallbackCwd: () => process.cwd(),
    }))
  }

  // 循环卫生：编排者反复调用 `list_agents` 假装自己在等待，实测单次会话 1069 次、
  // 最长连续 149 次，直到模型额度耗尽。与 gate.enabled 同理，这里也在挂载时读一次。
  if (config.loopGuard.enabled) {
    ctx.effect(() => registerLoopGuard(ctx, {
      listingLimit: () => current.loopGuard.maxConsecutiveAgentListings,
      // 全部角色工具：任何一个被派发即进入等待期。
      roleToolNames: () => coordinator.mountedToolNames(),
      // 与 gate 的 implementerToolNames 同一条命名规则：精确匹配，不能用
      // startsWith('subagent_reviewer')，那会把自定义角色 `reviewer-v2` 也算进来。
      reviewerToolNames: () => coordinator.mountedToolNames()
        .filter(name => name === 'subagent_reviewer' || name.startsWith('subagent_reviewer_')),
    }))
  }

  // 同一模式，见上面 `commands` 块的注释：`settings` 不在顶层 `inject` 里，
  // 走 `ctx.inject(['settings'], ...)` 而不是一次性的 `ctx.get('settings')`
  // 快照。效果挂在回调参数的 `sctx` 上（而非外层 `ctx`），这样 `settings`
  // 服务消失时子 fiber 能正确回收。
  ctx.inject(['settings'], sctx => {
    sctx.effect(() => registerCrewSettings(sctx, config, next => {
      current = next
      void coordinator.sync(current.roles)
    }))
  })

  // 同一模式：`webServer` 也不在顶层 `inject` 里，HTTP 路由的注册走
  // `ctx.inject(['webServer'], ...)`。
  ctx.inject(['webServer'], hctx => {
    // 插件自有的命名空间不在 dsh settings RPC 的服务端白名单
    // （`WEB_SETTINGS_NAMESPACES`，见 packages/host/apiproxy/src/api-proxy.ts）内，
    // 加入清单是宿主应用的决定，不是注册插件能单方面做到的；因此配置读写必须走
    // 本插件自建的 HTTP 路由，客户端界面（若交付）也通过它读写，而非
    // `ctx.settingsScope`。
    //
    // 读取本命名空间当前的脱敏描述符（`SettingsDescriptor`，已解析值在 `.value`
    // 字段）。两条 HTTP 路由都要经它，而不是直接读闭包变量 `current`：
    // 1）`current` 只在 `registerCrewSettings` 的 `onChange` 回调里赋值，那个回调由
    //    `scope.watch()` 异步触发，不保证在一次 `settings.update()` 的 await 完成
    //    前跑完——写后立即读 `current` 可能回显写入前的旧值。
    // 2）`describe({ redactSecrets: true })` 是 dsh 规定每个 wire surface 都必须
    //    调用的入口：本插件的 schema 目前没有 `role('secret')` 字段所以无害，但这
    //    条路径是将来任何人往 schema 里加密钥字段时的唯一防线——直接返回 `current`
    //    会绕开脱敏，把明文密钥发到浏览器。
    //
    // 这里的 `hctx.get('settings')` 是每次 HTTP 请求到达时才求值的懒读取，不是
    // apply() 时机的一次性快照，所以不受本节顶部注释描述的竞态影响：`settings`
    // 缺失（或还没就绪）时自然回退到入口配置 `current`，且下一次请求会重新判断，
    // 不会永久卡死在错误分支——`settings` 是否就绪不影响 `webServer` 这条依赖链，
    // 因此这里没有把 `settings` 也加进 `ctx.inject` 的依赖列表。
    const describeSelf = () => hctx.get('settings')
      ?.describe({ redactSecrets: true })
      .find(descriptor => descriptor.ns === SETTINGS_NAMESPACE)

    hctx.effect(() => registerCrewApi(hctx, {
      // 未组合 settings 服务（如某些 headless 部署）时回退到入口配置 `current`。
      readConfig: () => (describeSelf()?.value as ConfigType | undefined) ?? current,
      readRevision: () => describeSelf()?.revision ?? 0,
      writeConfig: async (patch, expectedRevision) => {
        const settings = hctx.get('settings')
        if (settings === undefined) throw new Error('no settings provider composed')
        // `update()`（合并局部 patch）而非 `replace()`（整体替换）：配置界面读到的
        // 是 §7.1 提到的脱敏描述符，若以此重建整份 section 再 wholesale replace，
        // 会把 wire 从未返回的每一个密钥字段一并清空——dsh-settings 的 README 专门
        // 警告过这个场景。`update()` 的 merge-then-validate 会先合并进已持久化的
        // 用户 section 再校验，调用方未提交的字段保留原值而不是被 schema 默认值
        // 覆盖；这条校验同时满足「写入前必须用 ConfigSchema 校验」的要求，http.ts
        // 不需要再独立解析一次。
        await settings.update(SETTINGS_NAMESPACE, patch, expectedRevision)
      },
      mountedToolNames: () => coordinator.mountedToolNames(),
      skippedRoutes: () => lastSkipped,
      // 两个枚举接口的路由键字段名不同（`id` vs `provider`），与 health.ts 的
      // 三态判定同一处上游差异。
      listProviders: () => ({
        live: ctx.llm.listProviders().map(entry => entry.id),
        configurable: ctx.llm.listConfigurableProviders().map(entry => entry.provider),
      }),
      listModels: async provider => {
        try {
          return (await ctx.llm.listModels(provider)).map(model => model.id)
        } catch {
          // 未注册的路由（界面上处于 `unconfigured` 的那些）会让宿主的
          // `listModels` 抛错。这不是故障：目录本就只对活路由有意义，界面在
          // 空列表下仍允许手填。
          return []
        }
      },
      trustedHosts: [],
    }))
  })

  void coordinator.sync(current.roles)
  ctx.on('llm/adapters-updated', () => { void coordinator.sync(current.roles) })
}
