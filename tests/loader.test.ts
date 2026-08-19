import { Context, Service } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import * as crew from '../src/index.ts'
import { SETTINGS_NAMESPACE } from '../src/settings.ts'

/** 最小 llm 替身：只提供协调器读取拓扑所需的两个方法。 */
class FakeLlm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
  listProviders() { return [{ id: 'fake-provider', name: 'Fake' }] }
  listConfigurableProviders() { return [] }
}

/**
 * 最小 tools 替身：记录注册过的工具名。
 *
 * `register()` 的注销经 `this.ctx.effect()` 挂出，而不是直接返回一个裸
 * disposer。`this.ctx` 在这里是调用方上下文，不是 FakeTools 自己构造时的
 * 上下文：cordis 的 `Service` 基类按访问方重绑定它（`tracker = { property:
 * 'ctx' }`），真实 `@deepseek-ai/dsh-tools` 的 `register()` 正是靠这一点把
 * 注销与调用方 fiber 的生命周期绑定——`@deepseek-ai/dsh-tool-subagent` 的
 * `apply()` 从未自己调用注销函数，工具随 `ctx.plugin(subagentTool, ...)`
 * 的 fiber dispose 消失全靠这条自动回收路径。用裸 disposer 会让第一个
 * it() 的「fiber dispose 后工具消失」断言真的失败：委派工具的 fiber 卸载
 * 时没有任何东西会调用它。
 *
 * `guard()` 目前无人调用，是为下一个任务预留的：协调器接入
 * `ctx.tools.guard()` 后，真实 `apply()` 会调用它，缺了这个方法会让本文件
 * 突然报错。
 */
class FakeTools extends Service {
  readonly registered = new Set<string>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(definition: { name: string }) {
    return this.ctx.effect(() => {
      this.registered.add(definition.name)
      return () => { this.registered.delete(definition.name) }
    })
  }
  restrict() { return () => {} }
  guard() { return () => {} }
}

/**
 * 最小 subagents 替身。
 *
 * `getProvider()` 是真实 `@deepseek-ai/dsh-tool-subagent` 的 `apply()` 在挂载
 * 时同步查询的方法：它以 `config.provider` 查找一个已注册的 provider，找到
 * 就立即挂载委派工具。返回类型标注为上游 `SubagentProvider`，让 tsc 校验这个
 * 替身没有漏掉必需字段：`capabilities.depthLimit` 使真实 `maxDepth`（默认数值
 * 3）校验通过，`prepareContinuable` 的存在使 `backgroundMode: 'continuable'`
 * （`SubagentToolConfig` 固定值）校验通过——缺其中任何一个都会让真实 apply()
 * 在挂载时同步抛错。`start()` 本测试从不触发（不调用委派工具的 execute），
 * 留空抛错即可。
 */
class FakeSubagents extends Service {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  capabilities() { return { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }
  getProvider(name: string): SubagentProvider | undefined {
    if (name !== 'spawn') return undefined
    return {
      name: 'spawn',
      capabilities: this.capabilities(),
      inheritsParentContext: false,
      start: () => { throw new Error('not implemented in this stand-in') },
      prepareContinuable: async () => ({}),
    }
  }
}

/**
 * 最小 systemPrompt 替身。
 *
 * `@deepseek-ai/dsh-tool-subagent` 的 `inject` 数组包含 `'tools' | 'subagents'
 * | 'systemPrompt'` 三项，brief 给出的替身列表里没有第三个。缺了它，
 * `ctx.plugin(subagentTool, ...)` 的 fiber 会永远停在 `PENDING`（等待缺失的
 * inject 服务）：`await fiber` 正常解决、不抛错，但插件的 `apply()` 从未运行，
 * 委派工具也就从未注册——这是一处比抛错更隐蔽的失败模式，实测验证后补上。
 * `section()` 的返回值本身不参与断言，只需不抛错。
 */
class FakeSystemPrompt extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  section() { return () => {} }
}

/**
 * 最小 skills 替身。
 *
 * `registerCrewSkills()` 消费 `ctx.skills.register()`，因此 `apply()` 的
 * `inject` 数组里加了 `'skills'`。缺了这项替身，`ctx.plugin(crew, ...)` 的
 * fiber 会停在 `PENDING`，与上面 `FakeSystemPrompt` 注释描述的失败模式相同：
 * 委派工具从未注册。`register()` 的返回值本身不参与断言，只需是可调用的 disposer。
 */
class FakeSkills extends Service {
  constructor(ctx: Context) { super(ctx, 'skills') }
  register() { return () => {} }
}

/**
 * 最小 commands 替身：记录注册过的命令名。
 *
 * `register()` 的注销经 `this.ctx.effect()` 挂出，理由与上面的 `FakeTools` 完全
 * 相同：`dsh-dev-crew` 通过 `ctx.get('commands')?.register(...)` 而非
 * `ctx.commands.register(...)` 拿到这个服务，但 cordis 的 tracer/shadow 机制对
 * `ctx.get()` 同样生效——`get()` 是 `reflect` 服务经 `ctx.mixin()` 挂到 `ctx` 上的
 * 方法，调用时 `this` 被重绑定为发起调用的 fiber 的 ctx（这里是 `dsh-dev-crew`
 * 自己的 ctx），返回值也带着同一个 tracker，因此其上的 `register()` 内部
 * `this.ctx` 仍是调用方 ctx，`this.ctx.effect()` 把注销与 `dsh-dev-crew` 的 fiber
 * 绑定。`commands` 不在 `inject` 声明里（可选服务），因此不像 `FakeTools`/
 * `FakeSkills` 那样是每个用例的必需前置——只有本文件里显式验证命令入口的用例
 * 才需要挂载它。
 */
class FakeCommands extends Service {
  readonly registered = new Set<string>()
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(definition: { name: string }) {
    return this.ctx.effect(() => {
      this.registered.add(definition.name)
      return () => { this.registered.delete(definition.name) }
    })
  }
}

/**
 * 最小 webServer 替身：记录注册过的路由，供「服务晚到达」时序回归测试使用
 * （见下面 `describe('service arriving after the plugin is already active', ...)`）。
 *
 * `register()` 直接返回一个裸 disposer，不经 `this.ctx.effect()` 包一层：真实
 * `@deepseek-ai/dsh-host-webserver` 的 `WebServer.register()` 正是这样实现的
 * （往内部 Map 里 `set`/`delete`，没有自己的 effect 绑定）——`src/index.ts` 里
 * `hctx.effect(() => registerCrewApi(hctx, {...}))` 才是负责把注销与 `hctx`
 * 这个子 fiber 生命周期绑定的那一层，替身应该照实模拟被调用方，不能替调用方
 * 多做那一步。
 */
class FakeWebServer extends Service {
  readonly routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  constructor(ctx: Context) { super(ctx, 'webServer') }
  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
    this.routes.push(route)
    return () => {
      const at = this.routes.indexOf(route)
      if (at !== -1) this.routes.splice(at, 1)
    }
  }
}

/**
 * 调用一个已注册路由 handler 的最小 req/res 替身，返回状态码与解析后的
 * JSON body——用来确认注册上的路由不只是"存在"，还真的能处理请求。
 */
function invokeRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  options: { method: string; url: string; host: string },
): Promise<{ status: number; payload: { ok: boolean } }> {
  return new Promise(resolve => {
    const req = { method: options.method, url: options.url, headers: { host: options.host }, on() {} }
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body?: string) {
        resolve({ status: res.statusCode, payload: JSON.parse(body ?? '{}') as { ok: boolean } })
      },
    }
    void handler(req as never, res as never)
  })
}

/**
 * 最小 settings 替身：记录注册过的命名空间，供下面的时序回归测试使用。只实现
 * `registerCrewSettings` 实际调用的部分（`register()` 与它返回的 `get`/`watch`），
 * 不追求匹配 `SettingsProvider` 的完整契约——与本文件其余替身同样的取舍。
 */
class FakeSettings extends Service {
  readonly registeredNamespaces = new Set<SettingsNamespace>()
  constructor(ctx: Context) { super(ctx, 'settings') }
  register(ns: SettingsNamespace) {
    this.registeredNamespaces.add(ns)
    const value = {
      roles: [],
      gate: { enabled: true, plansDir: 'docs/plans' },
      artifactDirs: [],
      pipeline: { maxConvergenceRounds: 3 },
    }
    return { get: () => value, watch: () => () => {} }
  }
}

/**
 * 等待协调器的串行队列排空。
 *
 * 不用固定延迟：那既可能不够（慢机器上偶发失败）又总是浪费时间。协调器的
 * 每次 sync 都是微任务链，连续让出两轮事件循环即可保证它们全部结算。
 */
async function drainCoordinator(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

describe('plugin under a real cordis context', () => {
  it('registers a role tool and removes it when the fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)

    const fiber = ctx.plugin(crew, {
      roles: [{
        id: 'implementer',
        enabled: true,
        models: [{ alias: 'default', provider: 'fake-provider', model: 'm' }],
      }],
    })
    await fiber
    await drainCoordinator()

    const tools = ctx.get('tools') as unknown as FakeTools
    expect([...tools.registered]).toContain('subagent_implementer')

    await fiber.dispose()
    await drainCoordinator()
    expect([...tools.registered]).not.toContain('subagent_implementer')
  })

  it('registers nothing when the role provider is unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)

    const fiber = ctx.plugin(crew, {
      roles: [{
        id: 'implementer',
        enabled: true,
        models: [{ alias: 'default', provider: 'absent-provider', model: 'm' }],
      }],
    })
    await fiber
    await drainCoordinator()

    const tools = ctx.get('tools') as unknown as FakeTools
    expect([...tools.registered]).not.toContain('subagent_implementer')
  })

  it('registers no role tool under the default config (every builtin role disabled)', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)

    const fiber = ctx.plugin(crew, {})
    await fiber
    await drainCoordinator()

    const tools = ctx.get('tools') as unknown as FakeTools
    // crew_init 是与角色无关的产物目录初始化工具，不受任何角色启停影响，
    // 因此始终挂载；断言整个已注册集合而不是「不含 subagent_ 前缀」，这样
    // 若 crew_init 的挂载分支被误删或被套进错误的 if，这里也会失败，而不是
    // 因为「碰巧没有角色工具」而继续通过。
    expect([...tools.registered]).toEqual(['crew_init'])
  })

  it('registers /crew-init when a commands service is present, and removes it when the fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)
    await ctx.plugin(FakeCommands)

    const fiber = ctx.plugin(crew, {})
    await fiber
    await drainCoordinator()

    const commands = ctx.get('commands') as unknown as FakeCommands
    expect([...commands.registered]).toEqual(['crew-init'])

    await fiber.dispose()
    await drainCoordinator()
    expect([...commands.registered]).not.toContain('crew-init')
  })
})

/**
 * `webServer`/`settings`/`commands` 都不在 `apply()` 的顶层 `inject` 数组里
 * （见 `src/index.ts` 顶部注释）：`crew` 插件在这三个服务缺席时也必须先变
 * ACTIVE，然后各自的 `ctx.inject([...], childCtx => {...})` 子 fiber 在依赖
 * 迟到时停在 PENDING，直到依赖真正出现才执行。
 *
 * 这组用例专门回归一个真实复现过的缺陷：`src/index.ts` 曾经用一次性的
 * `ctx.get('webServer')`/`ctx.get('settings')` 快照判断"有没有"——服务碰巧还
 * 没轮到自己的 fiber 完成注册时，快照会把"已组合但还没就绪"误判成"未组合"，
 * 路由/命名空间从此永久不会注册，且没有任何报错（2026-08-19 在真实组合了
 * Web host 的 profile 上实测复现）。`tests/http.test.ts`/`tests/settings.test.ts`
 * 里的替身都是立即可用的，构造时就已经 `ctx.get(name)` 能读到值，因此两份文件
 * 都无法复现这个时序缺陷——它们验证的是"服务存在时代码对不对"，不是"服务还不
 * 存在时代码会不会永久放弃"。这里反过来：先让 `crew` 在服务缺席下变 ACTIVE，
 * 断言此刻确实还没有任何注册（证明前提成立，不是"服务其实一直都在"），然后才
 * 让服务出现，断言注册这才发生——这正是 `ctx.reflect.provide()` → `notify()`
 * 回溯通知全部等待中的 fiber 的因果链条在起作用。若 `src/index.ts` 里任何一处
 * 被人「简化」回 `ctx.get(name)`（哪怕是照着 dsh 包规范里"可选服务用 `ctx.get`"
 * 那句写的），这里的三个用例都会失败：`ctx.get()` 在依赖迟到的分支上第二次断言
 * 永远读不到值。
 */
describe('service arriving after the plugin is already active', () => {
  it('registers /crew/api only once webServer arrives, not before', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)

    const fiber = ctx.plugin(crew, {})
    await fiber
    await drainCoordinator()

    // 前提：此刻 webServer 确实还不存在，`registerCrewApi` 的
    // `ctx.inject(['webServer'], ...)` 子 fiber 必然还停在 PENDING。
    expect(ctx.get('webServer')).toBeUndefined()

    // webServer 在 crew 已经 ACTIVE 之后才出现。
    await ctx.plugin(FakeWebServer)
    await drainCoordinator()

    const webServer = ctx.get('webServer') as unknown as FakeWebServer
    const route = webServer.routes.find(candidate => candidate.path === '/crew/api')
    expect(route).toBeDefined()

    // 不只是"注册了"，还要能真的处理请求。
    const result = await invokeRoute(route!.handler, { method: 'GET', url: '/crew/api/health', host: 'localhost' })
    expect(result.status).toBe(200)
    expect(result.payload.ok).toBe(true)
  })

  it('registers the settings namespace only once settings arrives, not before', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)

    const fiber = ctx.plugin(crew, {})
    await fiber
    await drainCoordinator()

    expect(ctx.get('settings')).toBeUndefined()

    await ctx.plugin(FakeSettings)
    await drainCoordinator()

    const settings = ctx.get('settings') as unknown as FakeSettings
    expect(settings.registeredNamespaces.has(SETTINGS_NAMESPACE)).toBe(true)
  })

  it('registers /crew-init only once commands arrives, not before', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLlm)
    await ctx.plugin(FakeTools)
    await ctx.plugin(FakeSubagents)
    await ctx.plugin(FakeSystemPrompt)
    await ctx.plugin(FakeSkills)

    const fiber = ctx.plugin(crew, {})
    await fiber
    await drainCoordinator()

    expect(ctx.get('commands')).toBeUndefined()

    await ctx.plugin(FakeCommands)
    await drainCoordinator()

    const commands = ctx.get('commands') as unknown as FakeCommands
    expect([...commands.registered]).toContain('crew-init')
  })
})
