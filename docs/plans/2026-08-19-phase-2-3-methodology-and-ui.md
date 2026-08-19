# dsh-dev-crew 阶段二 + 三：方法论与配置界面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `dsh-dev-crew` 从「角色路由工具」变成「可安装的开发方法论」：四份内嵌 skill 驱动八步流水线，纪律 guard 强制产物走文件，流程产物目录可一键初始化，并提供图形化的角色与流水线配置。

**Architecture:** 沿用阶段一的「决策与副作用分离」。新增的纯逻辑（路径解析、初始化计划、配置投影）全部是可单测的纯函数；副作用集中在 `apply()` 与 `CrewCoordinator`。挂载协调器先从 `index.ts` 抽出成可注入依赖的对象，使并发、重名、失败三条路径可测 —— 这是阶段三配置热更新的前提。四份 skill 以运行时内嵌方式注册，随包分发。

**Tech Stack:** TypeScript、esbuild、vitest、React 18（仅阶段三客户端）、Node ^22.19 || >=24。

## Global Constraints

- 包名 `dsh-dev-crew`，`type: module`，ESM only；相对 import 带 `.ts` 后缀。
- `@deepseek-ai/*` 全部作为 devDependencies 并 **pin 到精确版本 `0.1.0-rc.7`**（无 `^`）。运行时由宿主提供，构建时 external。库包的 npm `dist-tags.latest` 指向陈旧的 `0.0.1-rc.1`，**不可用 `latest` 或 `^`**。
- 复用官方插件工厂必须传入**整个模块命名空间**（`import * as x`），单独传 `apply` 会丢失 `inject`。
- 子代理后端固定 `spawn`、`backgroundMode` 固定 `continuable`，不提供 fork 选项。
- 可选字段保持「省略」语义：构造出的 config 中不出现未提供的键（不是 `undefined` 值，也不是空对象）。`toolFilter: { allow: [] }` 的语义是「只保留这零个工具」，会剥光子代理全部工具。
- **纪律 gate 用 `ctx.tools.guard()`，不是 `tools/pre-execute` waterfall。** guard 单调：后续 waterfall 无法把它的拒绝变回许可。代价是 guard **同步**，路径检查只能用同步 fs。
- **`researcher` 是可选扩展角色，不进默认流水线。** `crew` skill 的默认流程不得自动调用它。
- **路由指令必须由 skill 正文显式承担**：所有角色工具的 `description` 逐字节相同（上游 `dsh-tool-subagent` 的 description 只由 provider 种类与 backgroundMode 决定，不可配置），模型无法从描述分辨角色。
- 每个导出都要有 JSDoc；`src/types.ts` 只放类型。
- 现有 41 个测试必须持续通过，既有语义不得回归。

---

## File Structure

| 文件 | 阶段 | 职责 |
|---|---|---|
| `src/coordinator.ts` | 二 | 挂载协调器：记账、串行、增删（从 `index.ts` 抽出，依赖注入化） |
| `src/gate.ts` | 二 | `resolvePlanPath` 纯函数 + guard 注册 |
| `src/init.ts` | 二 | 流程产物目录初始化（纯计划 + 执行） |
| `src/skills/*.md` | 二 | 四份方法论正文，构建时内联为字符串 |
| `src/skills/index.ts` | 二 | skill 注册与 invocation 策略 |
| `src/settings.ts` | 三 | settings 命名空间注册与配置解析 |
| `src/http.ts` | 三 | fenced HTTP 路由（含信任边界） |
| `src/client/index.ts` | 三 | 客户端插件入口，注册 `settings.section` |
| `src/client/CrewSection.tsx` | 三 | 配置界面组件 |
| `tests/coordinator.test.ts` | 二 | 并发、重名、挂载失败、卸载失败 |
| `tests/loader.test.ts` | 二 | 真实 Loader 组合测试 |
| `tests/gate.test.ts` | 二 | 路径解析五步算法与围栏 |
| `tests/init.test.ts` | 二 | 幂等、不覆盖、路径可配 |
| `tests/skills.test.ts` | 二 | 四份 skill 注册与 invocation 策略 |
| `tests/settings.test.ts` | 三 | 配置解析与 revision 冲突 |
| `tests/http.test.ts` | 三 | 信任边界、请求体上限、方法限制 |

---

### Task 1: 抽出可测的挂载协调器

**Files:**
- Create: `src/coordinator.ts`
- Modify: `src/index.ts`
- Test: `tests/coordinator.test.ts`

**Interfaces:**
- Consumes: `MountSpec`、`planMounts`、`diffMounts`（`src/mount.ts`，阶段一）；`Config`（`src/types.ts`）
- Produces:
  - `interface MountFn { (spec: MountSpec): Promise<() => Promise<void>> }`
  - `interface CoordinatorDeps { mount: MountFn; readProviders: () => { live: readonly LiveProvider[]; configurable: readonly ConfigurableProvider[] }; onSkipped: (skipped: readonly SkippedRoute[]) => void; onError: (error: unknown) => void }`
  - `class CrewCoordinator { constructor(deps: CoordinatorDeps); sync(roles: readonly CrewRole[]): Promise<void>; mountedToolNames(): readonly string[]; dispose(): Promise<void> }`

阶段一把这段逻辑写在 `apply()` 的闭包里，因此并发同步、重复工具名、挂载失败、卸载失败四条路径全部无法自动化测试 —— 而它们是本插件唯一有状态、有时序、有失败路径的代码。阶段三的配置热更新会直接改这里，届时再抽风险更高。

`mountedToolNames()` 存在的原因：Task 3 的纪律 guard 需要知道当前挂了哪些 implementer 工具名，而这个信息此前只活在闭包里。

- [ ] **Step 1: 写失败测试 tests/coordinator.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest'
import { CrewCoordinator } from '../src/coordinator.ts'
import type { CoordinatorDeps } from '../src/coordinator.ts'
import type { CrewRole } from '../src/types.ts'

const live = [{ id: 'p1' }, { id: 'p2' }]

function role(id: string, provider: string, alias = 'default'): CrewRole {
  return { id, enabled: true, models: [{ alias, provider, model: 'm' }] }
}

function deps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    mount: async () => async () => {},
    readProviders: () => ({ live, configurable: [] }),
    onSkipped: () => {},
    onError: () => {},
    ...overrides,
  }
}

describe('CrewCoordinator', () => {
  it('mounts one tool per ready model on first sync', async () => {
    const mount = vi.fn(async () => async () => {})
    const c = new CrewCoordinator(deps({ mount }))
    await c.sync([role('implementer', 'p1')])
    expect(mount).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual(['subagent_implementer'])
  })

  it('does not remount an unchanged spec on a second sync', async () => {
    const mount = vi.fn(async () => async () => {})
    const c = new CrewCoordinator(deps({ mount }))
    const roles = [role('implementer', 'p1')]
    await c.sync(roles)
    await c.sync(roles)
    expect(mount).toHaveBeenCalledTimes(1)
  })

  it('disposes a tool whose role was removed', async () => {
    const dispose = vi.fn(async () => {})
    const c = new CrewCoordinator(deps({ mount: async () => dispose }))
    await c.sync([role('implementer', 'p1')])
    await c.sync([])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual([])
  })

  it('serializes concurrent syncs so the second observes the first', async () => {
    const order: string[] = []
    const mount = vi.fn(async (spec: { toolName: string }) => {
      order.push(`start:${spec.toolName}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${spec.toolName}`)
      return async () => {}
    })
    const c = new CrewCoordinator(deps({ mount }))
    // 两次 sync 不 await 第一次，模拟事件紧邻到达
    const first = c.sync([role('implementer', 'p1')])
    const second = c.sync([role('implementer', 'p1'), role('reviewer', 'p2')])
    await Promise.all([first, second])
    // 第一次挂载完整结束后第二次才开始，且未重复挂载 implementer
    expect(order).toEqual([
      'start:subagent_implementer', 'end:subagent_implementer',
      'start:subagent_reviewer', 'end:subagent_reviewer',
    ])
    expect(c.mountedToolNames()).toEqual(['subagent_implementer', 'subagent_reviewer'])
  })

  it('reports a mount failure through onError and leaves that tool unmounted', async () => {
    const onError = vi.fn()
    const c = new CrewCoordinator(deps({
      mount: async () => { throw new Error('INACTIVE_EFFECT') },
      onError,
    }))
    await c.sync([role('implementer', 'p1')])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual([])
  })

  it('does not leave the queue rejected after a mount failure', async () => {
    const c = new CrewCoordinator(deps({
      mount: async () => { throw new Error('boom') },
    }))
    await c.sync([role('implementer', 'p1')])
    // 后续 sync 仍能正常工作，说明队列未以被拒绝状态悬着
    await expect(c.sync([])).resolves.toBeUndefined()
  })

  it('reports a dispose failure through onError and still forgets the tool', async () => {
    const onError = vi.fn()
    const c = new CrewCoordinator(deps({
      mount: async () => async () => { throw new Error('dispose failed') },
      onError,
    }))
    await c.sync([role('implementer', 'p1')])
    await c.sync([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(c.mountedToolNames()).toEqual([])
  })

  it('surfaces a duplicate tool name as an error without mounting anything', async () => {
    const mount = vi.fn(async () => async () => {})
    const onError = vi.fn()
    const c = new CrewCoordinator(deps({ mount, onError }))
    await c.sync([role('dup', 'p1'), role('dup', 'p2')])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(mount).not.toHaveBeenCalled()
  })

  it('passes skipped routes to onSkipped', async () => {
    const onSkipped = vi.fn()
    const c = new CrewCoordinator(deps({ onSkipped }))
    await c.sync([role('implementer', 'nope')])
    expect(onSkipped).toHaveBeenCalledWith([
      { toolName: 'subagent_implementer', provider: 'nope', reason: 'missing' },
    ])
  })

  it('disposes every mounted tool on dispose()', async () => {
    const dispose = vi.fn(async () => {})
    const c = new CrewCoordinator(deps({ mount: async () => dispose }))
    await c.sync([role('implementer', 'p1'), role('reviewer', 'p2')])
    await c.dispose()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(c.mountedToolNames()).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/coordinator.test.ts`
Expected: FAIL，无法解析 `../src/coordinator.ts`。

- [ ] **Step 3: 写 src/coordinator.ts**

```ts
import type { ConfigurableProvider, LiveProvider } from './health.ts'
import type { MountSpec, SkippedRoute } from './mount.ts'
import { diffMounts, planMounts } from './mount.ts'
import type { CrewRole } from './types.ts'

/** 挂载一个委派工具实例，返回卸载它的函数。 */
export interface MountFn {
  (spec: MountSpec): Promise<() => Promise<void>>
}

/** 协调器的外部依赖，全部可注入以便测试。 */
export interface CoordinatorDeps {
  /** 实际执行挂载的函数；生产实现调用 `ctx.plugin()`。 */
  readonly mount: MountFn
  /** 读取当前的 provider 拓扑。 */
  readonly readProviders: () => {
    readonly live: readonly LiveProvider[]
    readonly configurable: readonly ConfigurableProvider[]
  }
  /** 每次同步后报告被跳过的路由。 */
  readonly onSkipped: (skipped: readonly SkippedRoute[]) => void
  /** 报告同步过程中的失败；协调器自身不决定如何呈现。 */
  readonly onError: (error: unknown) => void
}

interface MountedEntry {
  readonly spec: MountSpec
  readonly dispose: () => Promise<void>
}

/**
 * 挂载协调器：把「当前角色配置」同步成「当前已挂载的委派工具集合」。
 *
 * 全部公开方法通过一条 promise 链串行化。两次同步若并发执行，第二次会看不到
 * 第一次的挂载结果，导致同一个工具名被重复挂载 —— 而重复挂载的第二次会失败、
 * 其错误被 fiber 吞掉，同时覆盖第一个实例的卸载句柄，使那个工具再也卸不掉。
 */
export class CrewCoordinator {
  private readonly mounted = new Map<string, MountedEntry>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * 把已挂载集合同步到给定的角色配置。
   * @param roles - 当前配置中的角色列表。
   * @returns 本次同步完成的 promise；永不拒绝，失败通过 `onError` 报告。
   */
  sync(roles: readonly CrewRole[]): Promise<void> {
    this.queue = this.queue.then(() => this.runSync(roles), () => this.runSync(roles))
    return this.queue
  }

  /** 当前已挂载的工具名，按挂载顺序。 */
  mountedToolNames(): readonly string[] {
    return [...this.mounted.keys()]
  }

  /** 卸载全部已挂载的工具。 */
  dispose(): Promise<void> {
    this.queue = this.queue.then(() => this.runSync([]), () => this.runSync([]))
    return this.queue
  }

  private async runSync(roles: readonly CrewRole[]): Promise<void> {
    try {
      const { live, configurable } = this.deps.readProviders()
      const plan = planMounts(roles, live, configurable)
      const diff = diffMounts([...this.mounted.values()].map(entry => entry.spec), plan.specs)

      for (const toolName of diff.toRemove) {
        const entry = this.mounted.get(toolName)
        if (entry === undefined) continue
        // 先忘记再卸载：卸载失败时状态也不会停在「记着但已半死」。
        this.mounted.delete(toolName)
        try {
          await entry.dispose()
        } catch (error: unknown) {
          this.deps.onError(error)
        }
      }

      for (const spec of diff.toAdd) {
        try {
          const dispose = await this.deps.mount(spec)
          this.mounted.set(spec.toolName, { spec, dispose })
        } catch (error: unknown) {
          this.deps.onError(error)
        }
      }

      this.deps.onSkipped(plan.skipped)
    } catch (error: unknown) {
      // planMounts 对重复工具名 fail loud，落在这里。
      this.deps.onError(error)
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/coordinator.test.ts`
Expected: 10 个测试通过。

- [ ] **Step 5: 改写 src/index.ts 使用协调器**

```ts
import type { Context } from '@deepseek-ai/cordis'
// 整个模块命名空间一起传给 ctx.plugin：函数插件的 name / inject / Config / apply
// 是一组具名导出，单独传 apply 会丢失 inject。
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { Config } from './config.ts'
import { CrewCoordinator } from './coordinator.ts'
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
      // 拓扑通知在启动阶段连续到达；仅在跳过集合真正变化时输出。
      const key = JSON.stringify(skipped)
      if (key === lastSkippedKey) return
      lastSkippedKey = key
      for (const entry of skipped) logger.warn(adviseSkipped(entry))
    },
    onError: error => { logger.error(error) },
  })

  ctx.effect(() => () => { void coordinator.dispose() })

  void coordinator.sync(config.roles)
  ctx.on('llm/adapters-updated', () => { void coordinator.sync(config.roles) })
}
```

- [ ] **Step 6: 全量检查**

Run: `npm run check`
Expected: typecheck 通过、51 个测试通过（既有 41 + coordinator 10）、构建成功。

- [ ] **Step 7: 提交**

```bash
git add src/coordinator.ts src/index.ts tests/coordinator.test.ts
git commit -m "refactor: 抽出可测的挂载协调器

阶段一把挂载记账、串行队列、增删循环写在 apply() 闭包里，四条失败路径
无法自动化测试。抽成依赖注入的 CrewCoordinator 后，并发同步、重复工具名、
挂载失败、卸载失败均可覆盖；mountedToolNames() 同时为纪律 guard 提供
当前挂载的工具名集合。"
```

---

### Task 2: 真实 Loader 组合测试

**Files:**
- Create: `tests/loader.test.ts`
- Create: `tests/fixtures/crew-test.cordis.yml`
- Modify: `package.json`（devDependencies 追加 Loader 及其依赖）

**Interfaces:**
- Consumes: 完整插件（`src/index.ts`）
- Produces: 可重放的「工具确实注册 / fiber dispose 后确实消失」断言

设计文档第 9 节把它列为最关键的一项，阶段一交付为零，改由人工端到端验收承担。人工验收确实覆盖了真实加载路径，但**不可重放**：阶段二每加一个 skill、阶段三每改一次配置界面，都需要它来回答「工具还在不在」。

dsh 的 ACP 事故记录是这条测试存在的理由：178 个单元测试全绿、覆盖率 100%，一接真实客户端就崩 —— 所有测试都绕过了插件真正的加载路径。

- [ ] **Step 1: 追加测试依赖**

Run:
```bash
npm install -D @deepseek-ai/cordis-plugin-loader@0.1.0-rc.7 @deepseek-ai/dsh-subagent@0.1.0-rc.7
```

若解析失败，检查是否所有 `@deepseek-ai/*` 都在同一版本线（见 Global Constraints）。

- [ ] **Step 2: 写测试 tests/loader.test.ts**

```ts
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as crew from '../src/index.ts'

/** 最小 llm 替身：只提供协调器读取拓扑所需的两个方法。 */
class FakeLlm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
  listProviders() { return [{ id: 'fake-provider', name: 'Fake' }] }
  listConfigurableProviders() { return [] }
}

/** 最小 tools 替身：记录注册过的工具名。 */
class FakeTools extends Service {
  readonly registered = new Set<string>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(definition: { name: string }) {
    this.registered.add(definition.name)
    return () => { this.registered.delete(definition.name) }
  }
  restrict() { return () => {} }
}

/** 最小 subagents 替身：委派工具只需要它存在。 */
class FakeSubagents extends Service {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  capabilities() { return { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }
}

describe('plugin under a real cordis context', () => {
  it('registers a role tool and removes it when the fiber disposes', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(FakeTools)
    ctx.plugin(FakeSubagents)
    await ctx.start()

    const fiber = ctx.plugin(crew, {
      roles: [{
        id: 'implementer',
        enabled: true,
        models: [{ alias: 'default', provider: 'fake-provider', model: 'm' }],
      }],
    })
    await fiber
    // 让协调器的串行队列排空
    await new Promise(resolve => setTimeout(resolve, 20))

    const tools = ctx.get('tools') as unknown as FakeTools
    expect([...tools.registered]).toContain('subagent_implementer')

    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect([...tools.registered]).not.toContain('subagent_implementer')

    await ctx.stop()
  })

  it('registers nothing when the role provider is unavailable', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(FakeTools)
    ctx.plugin(FakeSubagents)
    await ctx.start()

    const fiber = ctx.plugin(crew, {
      roles: [{
        id: 'implementer',
        enabled: true,
        models: [{ alias: 'default', provider: 'absent-provider', model: 'm' }],
      }],
    })
    await fiber
    await new Promise(resolve => setTimeout(resolve, 20))

    const tools = ctx.get('tools') as unknown as FakeTools
    expect([...tools.registered]).not.toContain('subagent_implementer')

    await ctx.stop()
  })

  it('registers nothing under the default config (every builtin role disabled)', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(FakeTools)
    ctx.plugin(FakeSubagents)
    await ctx.start()

    const fiber = ctx.plugin(crew, {})
    await fiber
    await new Promise(resolve => setTimeout(resolve, 20))

    const tools = ctx.get('tools') as unknown as FakeTools
    expect(tools.registered.size).toBe(0)

    await ctx.stop()
  })
})
```

**若 `@deepseek-ai/dsh-tool-subagent` 的真实 `apply` 因替身服务不完整而抛错**：这本身是有价值的发现（说明替身缺了它真正依赖的东西）。补齐替身的缺失方法，不要改用 mock 掉整个 `ctx.plugin`。测试的价值正在于走真实加载路径。

- [ ] **Step 3: 运行测试**

Run: `npm run test -- tests/loader.test.ts`
Expected: 3 个测试通过。若因替身不完整而失败，按上一步的说明补齐替身，并在报告中记录补了什么 —— 那是关于上游真实依赖的新知识。

- [ ] **Step 4: 全量检查并提交**

Run: `npm run check`
Expected: 54 个测试通过。

```bash
git add tests/loader.test.ts package.json package-lock.json
git commit -m "test: 真实 cordis 上下文下的组合测试

设计文档第 9 节列为最关键、阶段一欠着的一项。替身只覆盖 llm/tools/
subagents 三个服务，插件本身与委派工具走真实加载路径，因此能回答
「工具确实注册 / fiber dispose 后确实消失」——这是人工 E2E 无法重放的。"
```

---

### Task 3: 纪律 gate

**Files:**
- Create: `src/gate.ts`
- Modify: `src/index.ts`
- Test: `tests/gate.test.ts`

**Interfaces:**
- Consumes: `CrewCoordinator.mountedToolNames()`（Task 1）
- Produces:
  - `interface PlanPathOptions { plansDir: string; cwd: string }`
  - `function resolvePlanPath(prompt: string, options: PlanPathOptions): string | undefined`
  - `function registerCrewGate(ctx, deps): () => void`

判据：**调用 implementer 角色的工具时，`prompt` 参数中必须包含至少一个可解析、真实存在、且位于配置的 plans 目录之内的文件路径。**

这条判据同时强制两件事：产物必须落盘，以及分派时必须传路径而非全文。后者是主代理上下文预算的核心约束 —— 若每份 plan 全文都塞进 prompt，长流水线跑到中段就会耗尽上下文。

机制用 `ctx.tools.guard()` 而非 `tools/pre-execute`：guard 单调，后续 waterfall 无法把它的拒绝变回许可。代价是 guard 同步，因此路径存在性检查只能用同步 fs，绕过 `ctx.fs` 沙箱 —— 判据只做本地只读的存在性判断，可接受。

- [ ] **Step 1: 写失败测试 tests/gate.test.ts**

```ts
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolvePlanPath } from '../src/gate.ts'

let root: string
let plansDir: string
let planFile: string
let outsideFile: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-gate-'))
  plansDir = join(root, 'docs', 'plans')
  mkdirSync(plansDir, { recursive: true })
  planFile = join(plansDir, '2026-08-19-feature.md')
  writeFileSync(planFile, '# plan')
  outsideFile = join(root, 'secret.md')
  writeFileSync(outsideFile, 'secret')
  symlinkSync(outsideFile, join(plansDir, 'escape.md'))
  mkdirSync(join(plansDir, 'subdir'))
})

const opts = () => ({ plansDir, cwd: root })

describe('resolvePlanPath', () => {
  it('accepts an absolute path inside the plans directory', () => {
    expect(resolvePlanPath(`按 ${planFile} 实现第 3 个任务`, opts())).toBe(planFile)
  })

  it('accepts a relative path resolved against cwd', () => {
    expect(resolvePlanPath('按 docs/plans/2026-08-19-feature.md 实现', opts())).toBe(planFile)
  })

  it('accepts a path wrapped in backticks', () => {
    expect(resolvePlanPath('按 `docs/plans/2026-08-19-feature.md` 实现', opts())).toBe(planFile)
  })

  it('accepts a path wrapped in double quotes', () => {
    expect(resolvePlanPath('read "docs/plans/2026-08-19-feature.md" first', opts())).toBe(planFile)
  })

  it('rejects a prompt with no path at all', () => {
    expect(resolvePlanPath('实现登录功能，写好测试', opts())).toBeUndefined()
  })

  it('rejects a path that does not exist', () => {
    expect(resolvePlanPath('按 docs/plans/nonexistent.md 实现', opts())).toBeUndefined()
  })

  it('rejects a path outside the plans directory', () => {
    expect(resolvePlanPath(`按 ${outsideFile} 实现`, opts())).toBeUndefined()
  })

  it('rejects traversal escaping the plans directory', () => {
    expect(resolvePlanPath('按 docs/plans/../secret.md 实现', opts())).toBeUndefined()
  })

  it('rejects a symlink pointing outside the plans directory', () => {
    // 围栏检查在 realpath 之后重做一次，否则符号链接可以绕过第一次检查。
    expect(resolvePlanPath('按 docs/plans/escape.md 实现', opts())).toBeUndefined()
  })

  it('rejects a directory even when it is inside the plans directory', () => {
    expect(resolvePlanPath('按 docs/plans/subdir 实现', opts())).toBeUndefined()
  })

  it('returns the first valid path when several are present', () => {
    const prompt = `参考 docs/plans/nonexistent.md 与 ${planFile}`
    expect(resolvePlanPath(prompt, opts())).toBe(planFile)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/gate.test.ts`
Expected: FAIL，无法解析 `../src/gate.ts`。

- [ ] **Step 3: 写 src/gate.ts 的纯函数部分**

```ts
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** `resolvePlanPath` 的解析上下文。 */
export interface PlanPathOptions {
  /** 配置的 plans 目录，可以是相对路径。 */
  readonly plansDir: string
  /** 相对路径的解析基准。 */
  readonly cwd: string
}

/**
 * 匹配候选路径片段：非空白且含有路径分隔符或 `.md` 后缀的连续串。
 * 前后可被反引号、单双引号、圆括号包裹，捕获时不含包裹符。
 */
const CANDIDATE = /[`'"(]?([^\s`'"()]*[/\\][^\s`'"()]*|[^\s`'"()]+\.md)[`'")]?/g

/**
 * 从 prompt 中解析出一个位于 plans 目录之内、真实存在的普通文件路径。
 *
 * 五步：候选提取 → `resolve` 规范化 → 围栏前缀检查 → 存在性与文件类型 →
 * `realpath` 后重做围栏检查。最后一步不可省略：否则 plans 目录内的符号链接
 * 可以指向目录之外，绕过第三步。
 * @param prompt - 委派工具收到的 prompt 参数。
 * @param options - plans 目录与相对路径基准。
 * @returns 第一个通过全部五步的绝对路径；没有则 `undefined`。
 */
export function resolvePlanPath(prompt: string, options: PlanPathOptions): string | undefined {
  const fence = resolve(options.plansDir) + sep
  for (const match of prompt.matchAll(CANDIDATE)) {
    const candidate = match[1]
    if (candidate === undefined || candidate === '') continue
    const absolute = resolve(options.cwd, candidate)
    if (!absolute.startsWith(fence)) continue
    if (!existsSync(absolute)) continue
    let real: string
    try {
      real = realpathSync(absolute)
    } catch {
      // 竞态：候选在 existsSync 与 realpathSync 之间消失。视为不通过。
      continue
    }
    if (!real.startsWith(fence)) continue
    if (!statSync(real).isFile()) continue
    return real
  }
  return undefined
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/gate.test.ts`
Expected: 11 个测试通过。

- [ ] **Step 5: 在 src/gate.ts 追加 guard 注册**

```ts
import type { Context } from '@deepseek-ai/cordis'

/** guard 注册所需的外部依赖。 */
export interface GateDeps {
  /** 当前挂载的 implementer 角色工具名；空集表示无需拦截。 */
  readonly implementerToolNames: () => readonly string[]
  /** 解析上下文。 */
  readonly options: () => PlanPathOptions
}

/** 拒绝理由：必须让模型知道怎么纠正，而不只是被拒。 */
const DENY_REASON
  = 'This implementer subagent must be given the path to a written plan file. '
  + 'Include the plan file path (inside the configured plans directory) in the prompt, '
  + 'and let the subagent read the file itself instead of pasting its contents here. '
  + 'If no plan exists yet, produce one first.'

/**
 * 注册纪律 guard：调用 implementer 角色工具时，prompt 中必须含一个可解析的
 * plan 文件路径。
 *
 * 用 `ctx.tools.guard()` 而非 `tools/pre-execute`：guard 是单调的，后续
 * waterfall 监听器无法把它的拒绝变回许可。这条判据不该被第三方插件覆盖。
 * @param ctx - 注册 guard 的上下文。
 * @param deps - 工具名集合与解析上下文的取值函数。
 * @returns 取消注册的 disposer。
 */
export function registerCrewGate(ctx: Context, deps: GateDeps): () => void {
  return ctx.tools.guard(execution => {
    const names = deps.implementerToolNames()
    if (!names.includes(execution.name)) return undefined
    const prompt = (execution.arguments as { prompt?: unknown }).prompt
    if (typeof prompt !== 'string') return DENY_REASON
    return resolvePlanPath(prompt, deps.options()) === undefined ? DENY_REASON : undefined
  })
}
```

- [ ] **Step 6: 在 src/types.ts 增加 gate 配置字段**

在 `Config` 接口中追加：

```ts
  /** 纪律 gate 配置。 */
  gate: {
    /** 是否启用。关闭只移除运行时强制，skill 正文仍要求传递路径。 */
    enabled: boolean
    /** plans 目录，相对路径按插件进程的 cwd 解析。 */
    plansDir: string
  }
```

在 `src/config.ts` 的 schema 中追加对应字段：

```ts
  gate: Schema.object({
    enabled: Schema.boolean().default(true),
    plansDir: Schema.string().default('docs/plans'),
  }).default({ enabled: true, plansDir: 'docs/plans' }),
```

- [ ] **Step 7: 在 src/index.ts 接入 guard**

在 `apply()` 中，`coordinator` 创建之后追加：

```ts
  if (config.gate.enabled) {
    ctx.effect(() => registerCrewGate(ctx, {
      implementerToolNames: () => coordinator.mountedToolNames()
        .filter(name => name.startsWith('subagent_implementer')),
      options: () => ({ plansDir: config.gate.plansDir, cwd: process.cwd() }),
    }))
  }
```

`inject` 追加 `'tools'` 已有，无需改动。

- [ ] **Step 8: 全量检查并提交**

Run: `npm run check`
Expected: 65 个测试通过（54 + gate 11），typecheck 与构建通过。

```bash
git add src/gate.ts src/types.ts src/config.ts src/index.ts tests/gate.test.ts
git commit -m "feat: 纪律 guard 强制 implementer 收到 plan 文件路径

用 ctx.tools.guard() 而非 tools/pre-execute waterfall：guard 单调，
后续监听器无法把拒绝变回许可。resolvePlanPath 五步解析含围栏检查与
realpath 后的二次围栏，封堵 ../ 逃逸与指向目录外的符号链接。"
```

---

### Task 4: 流程产物目录初始化

**Files:**
- Create: `src/init.ts`
- Modify: `src/index.ts`、`src/types.ts`、`src/config.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Produces:
  - `interface InitResult { created: string[]; skipped: string[] }`
  - `function initDirs(dirs: readonly string[], cwd: string): InitResult`
  - 模型可调用的工具 `crew_init`
  - 人可调用的命令 `/crew-init`

三条纪律：**幂等**（已存在就跳过，永不覆盖任何已有文件）、**不触碰用户的 agent 指令文件**（往 AGENTS.md 追加内容等于单方面改写用户每个会话的 system prompt）、**路径可配置**。

返回值必须区分「创建了」与「已存在」，否则调用方无法判断本次是否真的改变了什么。

- [ ] **Step 1: 写失败测试 tests/init.test.ts**

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initDirs } from '../src/init.ts'

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'crew-init-'))
}

const DIRS = ['docs/specs', 'docs/plans', 'docs/reports']

describe('initDirs', () => {
  it('creates every directory on a fresh project', () => {
    const root = freshRoot()
    const result = initDirs(DIRS, root)
    expect(result.created).toEqual(DIRS)
    expect(result.skipped).toEqual([])
    for (const dir of DIRS) expect(existsSync(join(root, dir))).toBe(true)
  })

  it('is idempotent: a second run creates nothing', () => {
    const root = freshRoot()
    initDirs(DIRS, root)
    const second = initDirs(DIRS, root)
    expect(second.created).toEqual([])
    expect(second.skipped).toEqual(DIRS)
  })

  it('never overwrites an existing file inside a target directory', () => {
    const root = freshRoot()
    mkdirSync(join(root, 'docs/plans'), { recursive: true })
    const existing = join(root, 'docs/plans', 'keep.md')
    writeFileSync(existing, 'original')
    initDirs(DIRS, root)
    expect(readFileSync(existing, 'utf8')).toBe('original')
  })

  it('reports partially existing directories correctly', () => {
    const root = freshRoot()
    mkdirSync(join(root, 'docs/plans'), { recursive: true })
    const result = initDirs(DIRS, root)
    expect(result.created).toEqual(['docs/specs', 'docs/reports'])
    expect(result.skipped).toEqual(['docs/plans'])
  })

  it('honors configured paths other than the defaults', () => {
    const root = freshRoot()
    const custom = ['documentation/design', '.spec']
    const result = initDirs(custom, root)
    expect(result.created).toEqual(custom)
    for (const dir of custom) expect(existsSync(join(root, dir))).toBe(true)
  })

  it('does not create an AGENTS.md or touch one that exists', () => {
    const root = freshRoot()
    const agents = join(root, 'AGENTS.md')
    writeFileSync(agents, 'user content')
    initDirs(DIRS, root)
    expect(readFileSync(agents, 'utf8')).toBe('user content')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/init.test.ts`
Expected: FAIL，无法解析 `../src/init.ts`。

- [ ] **Step 3: 写 src/init.ts**

```ts
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** 一次初始化的结果，区分本次创建与此前已存在。 */
export interface InitResult {
  /** 本次创建的目录，保持输入顺序。 */
  readonly created: string[]
  /** 此前已存在、本次跳过的目录。 */
  readonly skipped: string[]
}

/**
 * 创建流程产物目录。幂等：已存在的目录跳过，永不覆盖任何已有文件。
 *
 * 只创建目录，不写入任何文件，也不触碰用户的 agent 指令文件 —— 往 `AGENTS.md`
 * 追加内容等于单方面改写用户每个会话的系统提示词。目录约定写在插件自己的
 * skill 正文里。
 * @param dirs - 相对目录列表。
 * @param cwd - 解析基准。
 * @returns 创建与跳过的目录清单。
 */
export function initDirs(dirs: readonly string[], cwd: string): InitResult {
  const created: string[] = []
  const skipped: string[] = []
  for (const dir of dirs) {
    const absolute = resolve(cwd, dir)
    if (existsSync(absolute)) {
      skipped.push(dir)
      continue
    }
    mkdirSync(absolute, { recursive: true })
    created.push(dir)
  }
  return { created, skipped }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/init.test.ts`
Expected: 6 个测试通过。

- [ ] **Step 5: 在 src/types.ts 与 src/config.ts 增加产物目录配置**

`Config` 接口追加：

```ts
  /** 流程产物目录，相对项目根。 */
  artifactDirs: string[]
```

schema 追加：

```ts
  artifactDirs: Schema.array(Schema.string()).default(['docs/specs', 'docs/plans', 'docs/reports']),
```

- [ ] **Step 6: 在 src/index.ts 注册工具与命令**

在 `apply()` 中追加。注意 `ctx.commands` 是可选服务，用 `ctx.get()` 而非 `ctx.commands` —— 属性代理对拓扑敏感，未声明注入时读取会抛错；无命令适配器的部署（如 headless）仍应正常工作。

```ts
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
        properties: {
          created: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.created.length === 0
          ? `All artifact directories already exist: ${value.skipped.join(', ')}`
          : `Created: ${value.created.join(', ')}${value.skipped.length === 0 ? '' : `; already present: ${value.skipped.join(', ')}`}`,
      }],
    },
    execute: () => runInit(),
  })))

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
```

`src/index.ts` 顶部追加 import：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import { initDirs } from './init.ts'
```

- [ ] **Step 7: 全量检查并提交**

Run: `npm run check`
Expected: 71 个测试通过（65 + init 6）。

```bash
git add src/init.ts src/types.ts src/config.ts src/index.ts tests/init.test.ts
git commit -m "feat: 流程产物目录初始化，工具与命令双入口

crew_init 供模型在流水线需要落盘时调用，/crew-init 供人主动初始化，
共用一份幂等实现。只创建目录，不写文件，不触碰用户的 AGENTS.md。
命令注册走 ctx.get('commands') 可选服务，无命令适配器的部署照常工作。"
```

---

### Task 5: skill 注册基础设施 + `crew-brainstorm` + `crew-plan`

**Files:**
- Create: `scripts/build-skills.mjs`
- Create: `src/skills/crew-brainstorm.md`
- Create: `src/skills/crew-plan.md`
- Create: `src/skills/index.ts`
- Modify: `package.json`（`pretest` / `prebuild` 钩子）、`src/index.ts`、`.gitignore`
- Test: `tests/skills.test.ts`

**Interfaces:**
- Produces:
  - `src/skills/content.generated.ts` 导出 `SKILL_CONTENTS: Record<string, string>`
  - `function registerCrewSkills(ctx: Context): () => void`

**正文为什么用 `.md` 而不是 `.ts` 模板字符串**：正文里有大量 markdown 代码块，模板字符串需要转义每一个反引号，编辑与审阅都会变得痛苦。但 esbuild 不认识 vite 的 `?raw` 后缀，vitest 也不用 esbuild 的 `text` loader —— 两边无法共用同一种导入方式。

**解法**：构建前生成。`scripts/build-skills.mjs` 读取 `src/skills/*.md`，用 `JSON.stringify` 转义后写出 `src/skills/content.generated.ts`。构建与测试都消费这个 `.ts`，没有任何 loader 配置。生成物不提交（进 `.gitignore`），由 `pretest` / `prebuild` 钩子保证它总是最新的。

- [ ] **Step 1: 写生成脚本 scripts/build-skills.mjs**

```js
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'src/skills'
const entries = readdirSync(dir).filter(file => file.endsWith('.md')).sort()

const body = entries
  .map(file => `  ${JSON.stringify(file.replace(/\.md$/, ''))}: ${JSON.stringify(readFileSync(join(dir, file), 'utf8'))},`)
  .join('\n')

writeFileSync(join(dir, 'content.generated.ts'), `// 由 scripts/build-skills.mjs 生成，请勿手改。编辑 src/skills/*.md 后重新运行。
/** 四份方法论正文，键为 skill 名。 */
export const SKILL_CONTENTS: Record<string, string> = {
${body}
}
`)

console.log(`generated ${entries.length} skill contents`)
```

- [ ] **Step 2: 接上构建钩子并忽略生成物**

`package.json` 的 `scripts` 追加：

```json
    "build:skills": "node scripts/build-skills.mjs",
    "pretest": "node scripts/build-skills.mjs",
    "prebuild": "node scripts/build-skills.mjs",
    "pretypecheck": "node scripts/build-skills.mjs",
```

`.gitignore` 追加一行：

```
src/skills/content.generated.ts
```

- [ ] **Step 3: 写 src/skills/crew-brainstorm.md**

```markdown
---
name: crew-brainstorm
description: 把一个开发需求讨论成可实施的规格文档。用于流水线第一步，也可单独使用。
---

# 需求讨论

把一个模糊的需求讨论清楚，落盘成一份别人照着能实施的规格文档。**这是整条流水线里唯一需要人参与的环节。**

## 开始之前

先看清楚现场，不要基于想象提问：

- 项目里已有什么？读 README、最近的提交、相关目录结构
- 这个需求要动的地方，现在是怎么实现的
- 有没有既有的约定（命名、分层、测试方式）必须遵守

**探索的成本远低于基于错误假设讨论半小时。**

## 讨论

**一次只问一个问题。** 一口气抛五个问题，得到的是五个敷衍的答案。

问题优先级：目的 > 约束 > 成功判据 > 实现偏好。先搞清楚「为什么要做这个」，再谈「做成什么样」。

能给选项就给选项，并标出你的推荐和理由。开放式提问把认知负担全推给对方；带推荐的选择题让对方只需要判断"对不对"。

**遇到范围过大的需求，先拆分再深入。** 如果需求包含多个能独立交付的子系统，不要在第一个子系统的细节上打转 —— 先把拆分方案确认下来，再讨论第一个。每个子系统各自走一遍完整的规格 → 计划 → 实施。

## 提方案

理解清楚之后，提 2-3 个方案，每个带取舍。**先说你推荐哪个，为什么。**

YAGNI：每个方案里都删掉"以后可能有用"的部分。规格里多一句，实现时多一天。

## 呈现设计

分节呈现，每节讲完问一句"这样对吗"。不要写完整篇再一次性丢出去 —— 那样对方只能全盘接受或全盘推翻。

每节的篇幅要配得上它的复杂度：直白的部分几句话，有取舍的部分展开讲。

覆盖：架构与边界、组成部分与各自职责、数据流、失败处理、怎么验收。

## 落盘

写到配置的 specs 目录，文件名 `YYYY-MM-DD-<topic>.md`。

**规格文档写当前状态，不写讨论过程。** 不要出现"我们讨论了 A 和 B，最后选了 B" —— 只写"用 B，因为……"。读者要的是结论和理由，不是会议记录。

落盘后自检四项，发现问题直接改：

1. **占位符**：有没有 TBD、待定、"稍后补充"
2. **自相矛盾**：前后章节有没有冲突的表述
3. **歧义**：有没有哪条要求能被理解成两种意思，挑一种写死
4. **范围**：是不是一份实施计划能覆盖的量

## 交回

告诉对方规格已落盘、路径在哪、请他 review。**不要自己接着往下做** —— 规格没经过人确认就进入实施，是这条流水线最贵的失败方式。
```

- [ ] **Step 4: 写 src/skills/crew-plan.md**

```markdown
---
name: crew-plan
description: 把一份规格文档拆成可逐任务执行的实施计划。用于流水线第四步。
---

# 写实施计划

把规格拆成一串任务，每个任务由一个**没有本项目上下文**的执行者照着做就能完成。

## 读者假设

执行者是合格的工程师，但对这个项目、这套工具链、这个问题域一无所知。他不会读你的规格文档，只会读分配给他的那一个任务。

这意味着：**每个任务必须自带它需要的全部信息**。精确值（版本号、字段名、函数签名、测试用例）必须写在任务里，不能写"参考规格第 3 节"。

## 先定文件结构

拆任务之前，先列出会新建和修改哪些文件、各自负责什么。这一步锁定了后面所有的拆分决策。

一个文件一个职责。文件变大是职责变多的信号 —— 你也更容易在能一次读完的文件里改对代码。

## 任务粒度

一个任务 = 一个能独立验证的交付物 + 它自己的测试循环。

判据：**评审者能否在通过邻居任务的同时否决这一个。** 能，就该拆开；不能，就该合并。

配置、脚手架、文档这类附属工作，并进它服务的那个任务，不单独成任务。

## 每个任务写什么

**文件清单**：新建哪些、修改哪些（带行号范围）、测试文件在哪。

**接口契约**：这个任务消费什么（前面任务产出的确切签名）、产出什么（后面任务要依赖的确切名字与类型）。执行者只能看到自己的任务，这一段是他了解邻居的唯一途径。

**分步骤**，每步一个动作，2-5 分钟能做完：

1. 写失败的测试（**给出完整测试代码**）
2. 跑它，确认失败，以及失败信息长什么样
3. 写最小实现（**给出完整代码**）
4. 跑测试，确认通过
5. 提交

## 禁止事项

这些是计划本身的缺陷，不是风格问题：

- "TBD"、"稍后补充"、"根据情况处理"
- "加上适当的错误处理"、"补充必要的测试" —— 什么叫适当？什么叫必要？
- "写测试验证上述行为"却不给测试代码
- "与任务 N 类似" —— 执行者可能不按顺序读，把代码重复写出来
- 引用了任何任务中都没定义过的类型、函数、常量

## 全局约束

在计划开头单列一节，写下所有任务都必须遵守的东西：版本下限、依赖约束、命名规则、平台要求。精确值逐字照抄，不要转述。

每个任务的要求里都隐含包含这一节。

## 落盘与自检

写到配置的 plans 目录，文件名 `YYYY-MM-DD-<topic>.md`。

对照规格自检三项：

1. **覆盖**：规格里每条要求，能指到实现它的那个任务吗？指不出来的就是漏了。
2. **占位符**：搜一遍上面的禁止事项。
3. **类型一致**：任务 3 里叫 `clearLayers()` 的东西，任务 7 里是不是还叫这个名字。

发现问题直接改，不必重新review一遍。
```

- [ ] **Step 5: 写 src/skills/index.ts**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { SKILL_CONTENTS } from './content.generated.ts'

/** 一份内嵌 skill 的注册元数据。正文来自生成的 `SKILL_CONTENTS`。 */
interface CrewSkillMeta {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** 是否对模型可见。 */
  readonly modelInvocable: boolean
  /** 是否对人可见（作为命令）。 */
  readonly userInvocable: boolean
}

/**
 * 四份方法论的注册元数据。
 *
 * `crew-converge` 只对模型可见：它是流水线内部机制，人单独唤起没有意义。
 * 其余三份两个surface都开放，用户可以单独使用其中任何一份。
 */
const CREW_SKILLS: readonly CrewSkillMeta[] = [
  {
    name: 'crew',
    description: '端到端开发流水线：需求讨论、写计划、分派实现、多轮评审收敛、汇总报告。',
    whenToUse: '用户要求走完整开发流程，或明确提到 crew / 开发流水线时。',
    modelInvocable: true,
    userInvocable: true,
  },
  {
    name: 'crew-brainstorm',
    description: '把一个开发需求讨论成可实施的规格文档。',
    whenToUse: '需求模糊、需要先讨论清楚再动手时。',
    modelInvocable: true,
    userInvocable: true,
  },
  {
    name: 'crew-plan',
    description: '把一份规格文档拆成可逐任务执行的实施计划。',
    whenToUse: '已有规格、需要拆成可分派的任务时。',
    modelInvocable: true,
    userInvocable: true,
  },
  {
    name: 'crew-converge',
    description: '评审收敛协议：并行评审、分类阻塞项、修复复审、到上限转遗留。',
    whenToUse: '流水线内部机制，由 crew 调用。',
    modelInvocable: true,
    userInvocable: false,
  },
]

/**
 * 注册四份内嵌方法论 skill。
 *
 * 用运行时内嵌注册而非文件系统 provider：dsh 的 skill 发现根都在用户侧
 * （项目目录与 home 目录），插件自带的目录不在其中；内嵌注册让正文随包分发，
 * 不依赖任何路径解析。
 * @param ctx - 注册 skill 的上下文。
 * @returns 取消全部注册的 disposer。
 */
export function registerCrewSkills(ctx: Context): () => void {
  const disposers = CREW_SKILLS.map(meta => {
    const content = SKILL_CONTENTS[meta.name]
    if (content === undefined) {
      throw new Error(`skill content missing for "${meta.name}"; run scripts/build-skills.mjs`)
    }
    return ctx.skills.register({
      name: meta.name,
      description: meta.description,
      ...meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse },
      content,
      invocation: { modelInvocable: meta.modelInvocable, userInvocable: meta.userInvocable },
    })
  })
  return () => { for (const dispose of disposers) dispose() }
}
```

- [ ] **Step 6: 写 tests/skills.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest'
import { SKILL_CONTENTS } from '../src/skills/content.generated.ts'
import { registerCrewSkills } from '../src/skills/index.ts'

function fakeCtx() {
  const registered: { name: string; invocation: unknown; content: string }[] = []
  const disposers = vi.fn()
  return {
    registered,
    disposers,
    ctx: {
      skills: {
        register(skill: { name: string; invocation: unknown; content: string }) {
          registered.push(skill)
          return disposers
        },
      },
    } as never,
  }
}

describe('registerCrewSkills', () => {
  it('registers exactly the four crew skills', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    expect(registered.map(s => s.name)).toEqual(['crew', 'crew-brainstorm', 'crew-plan', 'crew-converge'])
  })

  it('keeps crew-converge invisible to human command surfaces', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    const converge = registered.find(s => s.name === 'crew-converge')
    expect(converge?.invocation).toEqual({ modelInvocable: true, userInvocable: false })
  })

  it('exposes the other three on both surfaces', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    for (const name of ['crew', 'crew-brainstorm', 'crew-plan']) {
      expect(registered.find(s => s.name === name)?.invocation)
        .toEqual({ modelInvocable: true, userInvocable: true })
    }
  })

  it('registers non-empty content for every skill', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    for (const skill of registered) expect(skill.content.length).toBeGreaterThan(200)
  })

  it('disposes every registration', () => {
    const { ctx, disposers } = fakeCtx()
    const dispose = registerCrewSkills(ctx)
    dispose()
    expect(disposers).toHaveBeenCalledTimes(4)
  })

  it('has generated content for all four skills', () => {
    expect(Object.keys(SKILL_CONTENTS).sort())
      .toEqual(['crew', 'crew-brainstorm', 'crew-converge', 'crew-plan'])
  })
})
```

注意：本任务只创建 `crew-brainstorm.md` 与 `crew-plan.md`，最后两个测试在 Task 6 补齐另外两份正文后才会通过。**本任务先写出全部六个测试，其中两个预期失败**，Task 6 完成后一并转绿 —— 这样 Task 6 的完成判据是客观的，而不是"看起来写完了"。在本任务的报告中如实记录这两个预期失败。

- [ ] **Step 7: 在 src/index.ts 注册 skill**

`apply()` 中追加：

```ts
  ctx.effect(() => registerCrewSkills(ctx))
```

`inject` 追加 `'skills'`：

```ts
export const inject = ['llm', 'tools', 'subagents', 'skills']
```

顶部追加 import：

```ts
import { registerCrewSkills } from './skills/index.ts'
```

- [ ] **Step 8: 运行测试**

Run: `npm run test -- tests/skills.test.ts`
Expected: 4 个通过、2 个失败（缺 `crew` 与 `crew-converge` 的正文）。这是预期状态。

- [ ] **Step 9: 提交**

```bash
git add scripts/build-skills.mjs src/skills/ src/index.ts package.json .gitignore tests/skills.test.ts
git commit -m "feat: skill 注册基础设施与前两份方法论正文

正文用 .md 编辑、构建前生成为 .ts：esbuild 不认 vite 的 ?raw 后缀，
vitest 不用 esbuild 的 text loader，生成一步让两边共用同一份内容且
无需任何 loader 配置。crew-converge 仅对模型可见，其余三份两面开放。

crew 与 crew-converge 的正文在下一个任务补齐，对应的两个测试当前
预期失败。"
```

---

### Task 6: `crew-converge` + `crew` 主编排正文

**Files:**
- Create: `src/skills/crew-converge.md`
- Create: `src/skills/crew.md`
- Test: `tests/skills.test.ts`（Task 5 已写，本任务使其全绿）

这两份是产品的核心资产。`crew` 决定流水线是否真被遵守，`crew-converge` 决定评审是否真的收敛。

**写作约束**：所有角色工具的 `description` 逐字节相同，模型无法从描述分辨角色 —— 因此正文必须**显式点名工具**（`subagent_implementer`、`subagent_reviewer_<alias>`），不能写"派给实现者"这种指望模型自己映射的说法。

- [ ] **Step 1: 写 src/skills/crew-converge.md**

```markdown
---
name: crew-converge
description: 评审收敛协议：并行评审、分类阻塞项、修复复审、到上限转遗留清单。
---

# 评审收敛协议

被 `crew` 在三个评审环节调用：规格评审、计划评审、代码评审。三处共用同一套判据。

## 一轮的执行

**在同一条消息里同时调用全部 reviewer 工具。** 工具名形如 `subagent_reviewer_<alias>`，用 `list_agents` 或工具清单确认当前有哪些实例。逐个串行调用不会让结论出错，但会白白拉长墙钟时间。

给每个 reviewer 的 prompt 里必须包含：

- **评审对象的文件路径**（规格/计划评审）或 **git 范围**（代码评审，形如 `<BASE>..HEAD`）。传路径，不传全文。
- 它自己去读的指令。评审者有文件读取工具。
- 判据：什么算阻塞、什么算非阻塞。

## 分类

拿到全部报告后，把问题分成两类：

**阻塞** —— 错误、自相矛盾、关键内容缺失、会让后续步骤失败或功能不正确。
**非阻塞** —— 风格、措辞、锦上添花、"覆盖率可以更高"。

分类是你的判断，不是照抄 reviewer 的严重性标签。**reviewer 可能是错的**：你有它没有的上下文。驳回一条意见时，把理由记下来 —— 被驳回的意见不计入阻塞，但必须出现在最终报告里，让人能复核你的判断。

## 收敛判据

**全部 reviewer 都没有阻塞项** = 收敛，进入下一步。

有阻塞项且未达轮数上限 → 修复 → 复审 → 再判一次。

**修复由谁做**：规格与计划的阻塞项，你自己改；代码的阻塞项，派 `subagent_implementer` 改。理由是文档修改通常是局部改写，你本来就持有全部上下文；代码修复需要跑测试，那是 implementer 的职责。

**复审用 `send_message` 发给同一个 reviewer 子代理**，不要重新起一个。它保留着上一轮的上下文，复审只需读变更部分。复审消息只写「改了什么」和「哪几条待确认」，不要重述已经通过的部分 —— 否则省 token 的说法就不成立了。

**修复后必须复审。** 自己改完自己说通过，等于没评审。

## 轮数上限

达到配置的上限仍有阻塞项 → **停止循环**，把剩余阻塞项写成遗留清单，继续下一步，并在最终报告里显著标注。

不要因为"只差一点"再来一轮。上限是规格，不是建议。

## 记录

每一轮记下：调用了哪些 reviewer、各自提了几条、分类结果、驳回了哪些及理由、本轮是否收敛。这些进最终报告。

如果某一轮的 reviewer 是被串行调用的（不在同一条消息里），记一次「串行降级」。不影响结论，但要让人知道。
```

- [ ] **Step 2: 写 src/skills/crew.md**

```markdown
---
name: crew
description: 端到端开发流水线：需求讨论、写计划、分派实现、多轮评审收敛、汇总报告。需求讨论是唯一的人工环节。
---

# 开发流水线

一条从需求到交付的流水线。**需求讨论是唯一需要人参与的环节**；规格落盘之后，直到最终报告，不再索要用户输入。

## 工具名不会告诉你该用哪个

本插件挂出的所有角色工具，在你的工具清单里**描述完全相同** —— 上游的委派工具不支持按角色定制描述。因此本文档逐处点名工具，照着调用，不要凭描述猜。

先用 `list_agents` 或工具清单确认当前挂了哪些：

- `subagent_implementer` —— 实现任务
- `subagent_reviewer_<alias>` —— 评审，可能有多个实例，每个绑不同模型
- `subagent_researcher` —— 调研，**默认流程不调用它**

## 八步

| # | 步骤 | 怎么做 |
|---|---|---|
| 1 | 需求讨论 | 加载 `crew-brainstorm`，按它执行，落盘规格 |
| 2 | 预检门 | 见下。任一项不满足即中止 |
| 3 | 规格评审 | 加载 `crew-converge`，对象是规格文件路径 |
| 4 | 写实施计划 | 加载 `crew-plan`，按它执行，落盘计划 |
| 5 | 计划评审 | `crew-converge`，对象是计划文件路径 |
| 6 | 逐任务实现 | 见下 |
| 7 | 代码评审 | `crew-converge`，对象是 `<BASE>..HEAD` |
| 8 | 最终报告 | 见下，落盘到 reports 目录 |

**第 1 步之后告诉用户一句**：规格已落盘、进入全自动阶段、完成或中止时汇报。此后到第 8 步之间不要提问。

## 第 2 步：预检门

逐项检查，**任一项不满足即中止并报告**，不降级、不绕过、不"先跑起来再说"：

1. **角色路由健康** —— implementer 与全部已启用的 reviewer 实例，其工具是否真的在你的工具清单里。不在，说明 provider 没配好。少一个 reviewer 就是降低了收敛标准，不能凑合。
2. **git 工作区干净** —— `git status --porcelain` 输出为空。未跟踪文件和已暂存改动都算脏：第 7 步以 `<BASE>..HEAD` 为评审范围，任何预先存在的改动都会混进来，让"这次做了什么"不可辨认。
3. **产物目录可写** —— specs / plans / reports 三个目录存在。不存在就调 `crew_init` 创建。

中止时说清楚：缺什么、怎么修、修好后从第几步继续。

## 第 6 步：逐任务实现

开始前记录基线：`BASE=$(git rev-parse HEAD)`。这个值第 7 步要用。

按计划逐个任务派 `subagent_implementer`。给它的 prompt 里**必须包含计划文件的路径** —— 纪律 guard 会检查这一点，没有路径的调用会被拒绝。

**不要把计划全文贴进 prompt。** 传路径，让子代理自己读。全文会吃掉你的上下文，而你还要跑完剩下的步骤。

给每个 implementer 的 prompt 应包含：任务编号、计划文件路径、这个任务依赖的前序任务产出了什么接口、以及"实现完自己提交，不要 amend 或 rebase 已有提交"。

一次派一个，不要并行 —— 并行 implementer 会在同一个工作区互相冲突。

## 失败与中断

| 情形 | 怎么办 |
|---|---|
| 预检门任一项不满足 | **中止** |
| 规格/计划评审到上限仍有阻塞 | **带遗留清单继续**，报告里标注 |
| 代码评审到上限仍有阻塞 | **带遗留清单继续**，报告里显著标注 |
| 第 6 步部分任务成功、部分失败 | **继续评审成功的部分**，失败任务进遗留清单 |
| 第 6 步结束时 `<BASE>..HEAD` 为空 | **中止** —— 没有交付物，空 diff 的"评审通过"是假阳性 |
| 第 6 步结束时工作区有未提交改动 | **中止** —— 那些改动真实存在却不在评审范围内 |
| 某个 reviewer 子代理被中断 | **中止** —— 收敛判据是"全部无阻塞"，缺一个无法判定 |
| 测试怎么都跑不过 | 按系统化调试排查；仍无解则**中止**，不伪造通过 |

中止时产物全部保留，报告写清：完成到哪一步、卡在哪、修复命令、恢复后从哪继续。

## 红旗清单

出现这些念头就停下来：

| 念头 | 现实 |
|---|---|
| "这轮评审没大问题，差不多收敛了" | 收敛 = 全部 reviewer 无阻塞项。"差不多"不是判据 |
| "有个 reviewer 没配好，用剩下的评审也一样" | 少一个视角就是降低标准。预检门不通过就是不通过 |
| "我自己也能当一个评审者" | 编排者不能兼任评审。你写的东西你自己看不出问题 |
| "上限到了但只差一点，再来一轮" | 上限是规格。剩余问题走遗留清单 |
| "顺手问一下用户确认" | 规格落盘后零打扰，只在完成或中止时汇报 |
| "计划文件太长，摘要贴进 prompt 更省事" | 传路径。摘要会丢掉实现者需要的精确值 |
| "这个任务简单，不用 implementer 我直接改" | 你直接改的代码没经过评审，且会污染你的上下文 |
| "工作区有点脏但不影响，先跑" | 脏工作区会混进第 7 步的评审范围 |
| "第 6 步没产生 commit，但改动都在，评审一下吧" | 空 diff 评审通过是最危险的假阳性 |
| "reviewer 说的这条不对，跳过不提" | 驳回可以，但必须记录理由进报告 |
| "researcher 闲着，顺便让它查点资料" | 默认流程不调用它。加进来就是加了一个没有判据的环节 |

## 第 8 步：最终报告

落盘到 reports 目录，文件名 `YYYY-MM-DD-<topic>-report.md`。必须包含：

- **产物路径**：规格、计划、代码 diff 概要
- **预检门结果**：逐项
- **三个评审环节**各自的轮次、参与的 reviewer、是否收敛
- **被驳回的评审意见及理由**
- **遗留问题清单**（若有，显著标注）
- **测试证据**：跑了什么命令、输出摘要
- **串行降级次数**（若有）
- **下一步选项**：合并 / 提 PR —— 这是用户重新介入的入口，由他决定

报告写完后，用一段话向用户汇报要点，不要让他自己去文件里找。
```

- [ ] **Step 3: 重新生成并跑全部 skill 测试**

Run: `npm run test -- tests/skills.test.ts`
Expected: 6 个测试全部通过（`pretest` 钩子会先重新生成 `content.generated.ts`）。

- [ ] **Step 4: 全量检查**

Run: `npm run check`
Expected: 77 个测试通过（71 + skills 6），typecheck 与构建通过。

- [ ] **Step 5: 人工确认正文可用性**

Read 四份 `.md`，逐份核对：

- `crew.md` 是否逐处点名了工具（不存在"派给实现者"这类需要模型自己映射的说法）
- `crew.md` 的失败语义表是否与规格 2.5 节一致
- `crew-converge.md` 是否要求"同一条消息里并行调用"且说明了串行降级如何记录
- 四份正文是否都没有引用 dsh 里不存在的东西（其他 skill 名、外部 CLI、浏览器伴随工具）

**最后一条尤其重要**：正文里引用一个够不着的东西，模型会去尝试、失败，然后自己编一个替代方案。

- [ ] **Step 6: 提交**

```bash
git add src/skills/
git commit -m "feat: crew 主编排与收敛协议正文

crew 逐处点名工具名而非依赖模型从描述分辨角色——所有角色工具的
description 逐字节相同，这是上游委派工具的固有限制。正文含预检门、
八步流水线、七种失败情形的处置、红旗清单与报告格式。

crew-converge 定义三个评审环节共用的收敛判据：并行发起、分类阻塞、
send_message 复审、到上限转遗留清单。"
```

---

## 阶段三：配置界面

---

### Task 7: settings 命名空间与配置热更新

**Files:**
- Create: `src/settings.ts`
- Modify: `src/mount.ts`（`diffMounts` 换结构化比较）、`src/index.ts`
- Test: `tests/settings.test.ts`、`tests/mount.test.ts`（追加）

**Interfaces:**
- Produces:
  - `function registerCrewSettings(ctx, base, onChange): () => void`
  - `function specKey(spec: MountSpec): string`（`diffMounts` 的比较键）

**必须先解决的前提问题**：`diffMounts` 当前用 `JSON.stringify(config)` 判断配置是否变化。它成立依赖两个条件 —— 键序稳定、`config` 对象引用在多次同步之间不变。阶段一两者都成立（`planMounts` 是唯一构造者，`apply` 的 `config` 是同一个闭包引用）。

**`applies: 'live'` + `scope.watch()` 会打破第二条**：每次配置变更都会产生一个全新的对象树，键序由 schemastery 的解析顺序决定，而非 `planMounts` 的字面量顺序。届时语义相同的两次计划可能被判为不同，导致工具被无谓地卸载重挂 —— 而重挂意味着所有会话的模型缓存前缀失效。

因此本任务先把判等换成结构化比较，再接热更新。

- [ ] **Step 1: 在 tests/mount.test.ts 追加结构化判等测试**

```ts
import { specKey } from '../src/mount.ts'

describe('specKey', () => {
  const base = {
    toolName: 'subagent_a',
    config: {
      provider: 'spawn' as const,
      toolName: 'subagent_a',
      backgroundMode: 'continuable' as const,
      agentOptions: { provider: 'p', model: 'm' },
      persona: 'you implement',
      toolFilter: { deny: ['subagent'] },
    },
  }

  it('is stable across differently ordered but semantically identical configs', () => {
    const reordered = {
      toolName: 'subagent_a',
      config: {
        toolFilter: { deny: ['subagent'] },
        persona: 'you implement',
        agentOptions: { model: 'm', provider: 'p' },
        backgroundMode: 'continuable' as const,
        toolName: 'subagent_a',
        provider: 'spawn' as const,
      },
    }
    expect(specKey(reordered)).toBe(specKey(base))
  })

  it('changes when the model changes', () => {
    const changed = { ...base, config: { ...base.config, agentOptions: { provider: 'p', model: 'other' } } }
    expect(specKey(changed)).not.toBe(specKey(base))
  })

  it('changes when the deny list content changes', () => {
    const changed = { ...base, config: { ...base.config, toolFilter: { deny: ['other'] } } }
    expect(specKey(changed)).not.toBe(specKey(base))
  })

  it('is stable across deny lists that differ only in order', () => {
    const a = { ...base, config: { ...base.config, toolFilter: { deny: ['x', 'y'] } } }
    const b = { ...base, config: { ...base.config, toolFilter: { deny: ['y', 'x'] } } }
    expect(specKey(a)).toBe(specKey(b))
  })

  it('distinguishes an absent persona from an empty one', () => {
    const withoutPersona = { toolName: 'subagent_a', config: { ...base.config } }
    delete (withoutPersona.config as { persona?: string }).persona
    const emptyPersona = { ...base, config: { ...base.config, persona: '' } }
    expect(specKey(withoutPersona)).not.toBe(specKey(emptyPersona))
  })
})
```

- [ ] **Step 2: 在 src/mount.ts 实现 specKey 并改用它**

```ts
/**
 * 一个挂载实例的语义比较键。
 *
 * 不用 `JSON.stringify(config)`：那依赖键序稳定，而配置热更新会让 schemastery
 * 产出一棵全新的对象树，键序不再由 `planMounts` 的字面量顺序决定。语义相同
 * 却键序不同会被判为「已变化」，导致工具无谓地卸载重挂——重挂使所有会话的
 * 模型缓存前缀失效。
 *
 * deny/allow 列表排序后参与比较：集合语义，顺序不构成语义差异。
 * @param spec - 待求键的挂载实例。
 * @returns 语义相同则相等的字符串键。
 */
export function specKey(spec: MountSpec): string {
  const c = spec.config
  const filter = c.toolFilter
  return JSON.stringify([
    spec.toolName,
    c.provider,
    c.backgroundMode,
    c.agentOptions.provider,
    c.agentOptions.model,
    c.agentOptions.maxTokens ?? null,
    'persona' in c ? c.persona : null,
    filter === undefined ? null : [
      filter.allow === undefined ? null : [...filter.allow].sort(),
      filter.deny === undefined ? null : [...filter.deny].sort(),
    ],
  ])
}
```

把 `diffMounts` 中两处 `JSON.stringify(...config)` 的比较替换为 `specKey(...)` 比较，其余逻辑不变。

- [ ] **Step 3: 跑 mount 测试**

Run: `npm run test -- tests/mount.test.ts`
Expected: 全部通过（既有 27 + specKey 5 = 32）。既有的「config 变化触发重挂」用例必须仍然通过 —— 它验证的是语义变化，不是键序。

- [ ] **Step 4: 写 tests/settings.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest'
import { registerCrewSettings } from '../src/settings.ts'
import { BUILTIN_ROLES } from '../src/config.ts'

function fakeCtx(scope: unknown) {
  return {
    get: (name: string) => name === 'settings' ? { register: () => scope } : undefined,
  } as never
}

describe('registerCrewSettings', () => {
  it('is a no-op returning a disposer when no settings provider is composed', () => {
    const ctx = { get: () => undefined } as never
    const dispose = registerCrewSettings(ctx, { roles: BUILTIN_ROLES }, () => {})
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('pushes the initial resolved value to onChange', () => {
    const onChange = vi.fn()
    const value = { roles: BUILTIN_ROLES }
    const scope = { get: () => value, watch: () => () => {}, dispose: () => {} }
    registerCrewSettings(fakeCtx(scope), value, onChange)
    expect(onChange).toHaveBeenCalledWith(value)
  })

  it('forwards watched updates to onChange', () => {
    const onChange = vi.fn()
    let watcher: ((next: unknown) => void) | undefined
    const scope = {
      get: () => ({ roles: [] }),
      watch: (cb: (next: unknown) => void) => { watcher = cb; return () => {} },
      dispose: () => {},
    }
    registerCrewSettings(fakeCtx(scope), { roles: [] }, onChange)
    const next = { roles: BUILTIN_ROLES }
    watcher?.(next)
    expect(onChange).toHaveBeenLastCalledWith(next)
  })

  it('stops forwarding after dispose', () => {
    const onChange = vi.fn()
    let watcher: ((next: unknown) => void) | undefined
    const unwatch = vi.fn()
    const scope = {
      get: () => ({ roles: [] }),
      watch: (cb: (next: unknown) => void) => { watcher = cb; return unwatch },
      dispose: () => {},
    }
    const dispose = registerCrewSettings(fakeCtx(scope), { roles: [] }, onChange)
    dispose()
    expect(unwatch).toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: 写 src/settings.ts**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema } from './config.ts'
import type { Config } from './types.ts'

/** 本插件的用户设置命名空间。 */
export const SETTINGS_NAMESPACE = 'dsh-dev-crew'

/**
 * 注册用户设置命名空间，并把解析后的配置推给调用方。
 *
 * 未组合 settings 服务的部署（例如 headless）不应因此失败：此时返回一个空
 * disposer，插件继续使用 cordis.yml 的入口配置。用 `ctx.get()` 而非属性代理，
 * 因为后者对拓扑敏感，未声明注入时读取会抛错。
 * @param ctx - 注册所在的上下文。
 * @param base - 组合层的配置，作为用户文档的叠加基底。
 * @param onChange - 初始值与每次变更都会调用。
 * @returns 取消注册与监听的 disposer。
 */
export function registerCrewSettings(
  ctx: Context,
  base: Config,
  onChange: (next: Config) => void,
): () => void {
  const settings = ctx.get('settings')
  if (settings === undefined) return () => {}

  const scope = settings.register(SETTINGS_NAMESPACE, ConfigSchema, {
    base,
    // 角色启停即时生效；协调器负责把工具集同步到新配置。
    applies: 'live',
  })

  onChange(scope.get())
  const unwatch = scope.watch((next: Config) => { onChange(next) })

  return () => {
    unwatch()
    scope.dispose?.()
  }
}
```

- [ ] **Step 6: 在 src/index.ts 接入热更新**

把 `apply()` 末尾的同步接线改为：

```ts
  let current = config
  ctx.effect(() => registerCrewSettings(ctx, config, next => {
    current = next
    void coordinator.sync(current.roles)
  }))

  void coordinator.sync(current.roles)
  ctx.on('llm/adapters-updated', () => { void coordinator.sync(current.roles) })
```

gate 的 `options()` 闭包同步改为读 `current.gate`，使配置变更后 plans 目录立即生效。

**注意**：`config.gate.enabled` 在挂载时决定是否注册 guard。热更新中途开关 gate 需要重新注册/注销 —— 本任务不实现该分支，`enabled` 变更在下次插件重载后生效。这是有意的范围限制，写进报告与 README。

- [ ] **Step 7: 全量检查并提交**

Run: `npm run check`
Expected: 86 个测试通过（77 + specKey 5 + settings 4）。

```bash
git add src/settings.ts src/mount.ts src/index.ts tests/settings.test.ts tests/mount.test.ts
git commit -m "feat: 用户设置命名空间与配置热更新

先把 diffMounts 的判等从 JSON.stringify 换成结构化 specKey：热更新会
让 schemastery 产出全新对象树，键序不再稳定，语义相同却键序不同会被
判为已变化，导致工具无谓重挂、所有会话的模型缓存前缀失效。

未组合 settings 服务的部署照常工作（空 disposer），继续使用入口配置。"
```

---

### Task 8: fenced HTTP API 与客户端配置界面

**Files:**
- Create: `src/http.ts`、`src/client/index.ts`、`src/client/CrewSection.tsx`、`src/client/api.ts`
- Modify: `package.json`（`dsh.client`、`exports["./client"]`、React devDeps）、`scripts/build.mjs`
- Test: `tests/http.test.ts`

**Interfaces:**
- Produces:
  - `function isTrustedHost(host: string | undefined, trusted: readonly string[]): boolean`
  - `function registerCrewApi(ctx, deps): () => void`
  - 客户端插件默认导出

**开工前先做 spike**：设计文档第 11 节把「客户端 `settings.section` 契约在 rc.7 是否可用」列为未决。**先花不超过半小时验证**：读 `~/.dsh/profiles/web/node_modules/` 下任一带 `dsh.client` 的第三方插件（例如 `dsh-context`），确认 `dsh.client` 的字段形状、`exports["./client"]` 的产物形态、以及 `settings.section` 的注册方式。

**若契约不可用或与预期不符**：不要硬扛。按设计文档第 11 节的退路降级 —— 只交付 HTTP API（Step 1-4），客户端界面推迟，并在报告中写明实测到的契约差异。降级不是失败，是把不确定性挡在交付之外。

- [ ] **Step 1: 写 tests/http.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { isTrustedHost } from '../src/http.ts'

describe('isTrustedHost', () => {
  const trusted: string[] = []

  it('accepts loopback hosts with a port', () => {
    for (const host of ['localhost:3080', '127.0.0.1:3080', '[::1]:3080']) {
      expect(isTrustedHost(host, trusted)).toBe(true)
    }
  })

  it('accepts loopback hosts without a port', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isTrustedHost(host, trusted)).toBe(true)
    }
  })

  it('rejects a missing Host header', () => {
    expect(isTrustedHost(undefined, trusted)).toBe(false)
  })

  it('rejects a non-loopback host', () => {
    expect(isTrustedHost('example.com', trusted)).toBe(false)
  })

  it('rejects a host that merely contains a loopback name', () => {
    // 防止 startsWith/includes 式的宽松判断放行 evil-localhost.com
    expect(isTrustedHost('evil-localhost.com', trusted)).toBe(false)
    expect(isTrustedHost('localhost.evil.com', trusted)).toBe(false)
  })

  it('rejects other 127.x addresses not explicitly trusted', () => {
    expect(isTrustedHost('127.0.0.2:3080', trusted)).toBe(false)
  })

  it('accepts an explicitly configured trusted host', () => {
    expect(isTrustedHost('dev.internal:8080', ['dev.internal'])).toBe(true)
  })
})
```

- [ ] **Step 2: 写 src/http.ts**

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SkippedRoute } from './mount.ts'
import type { Config } from './types.ts'

/** 回环主机名白名单。精确匹配，不做前缀或包含判断。 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** 请求体上限，防止一个畸形请求占满内存。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 判断请求的 Host 头是否可信。
 *
 * `ctx.webServer.register()` 不提供任何鉴权，信任边界由本插件自建。判断用
 * 精确匹配而非前缀或包含：`evil-localhost.com` 与 `localhost.evil.com` 都
 * 必须被拒绝。
 * @param host - 请求的 Host 头，可能缺失。
 * @param trusted - 部署显式配置的额外可信主机名。
 * @returns 是否放行。
 */
export function isTrustedHost(host: string | undefined, trusted: readonly string[]): boolean {
  if (host === undefined || host === '') return false
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0] ?? ''
  return LOOPBACK.has(name) || trusted.includes(name)
}

/** HTTP 路由的外部依赖。 */
export interface CrewApiDeps {
  readonly readConfig: () => Config
  readonly writeConfig: (next: Config) => Promise<void>
  readonly mountedToolNames: () => readonly string[]
  readonly skippedRoutes: () => readonly SkippedRoute[]
  readonly trustedHosts: readonly string[]
}

/**
 * 注册配置读写与健康查询的 HTTP 路由。
 *
 * 三条路由都要求 POST（`GET /health` 除外）与可信 Host。健康路由的存在是为了
 * 补上 headless 下 `logger.warn` 不可见的可观测性缺口：配错 provider 的用户
 * 至少能通过它拿到原因。
 * @param ctx - 注册所在的上下文，需已组合 `webServer`。
 * @param deps - 配置读写与状态查询。
 * @returns 取消注册的 disposer。
 */
export function registerCrewApi(ctx: Context, deps: CrewApiDeps): () => void {
  const server = ctx.get('webServer')
  if (server === undefined) return () => {}

  return server.register({
    kind: 'prefix',
    path: '/crew/api',
    handler: async (req: never, res: never) => {
      const request = req as unknown as { method?: string; url?: string; headers: Record<string, string | undefined>; on: (e: string, cb: (c?: unknown) => void) => void }
      const response = res as unknown as { statusCode: number; setHeader: (k: string, v: string) => void; end: (body?: string) => void }

      const send = (status: number, payload: unknown): void => {
        response.statusCode = status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(payload))
      }

      if (!isTrustedHost(request.headers.host, deps.trustedHosts)) {
        send(403, { ok: false, error: { code: 'UNTRUSTED_HOST', message: 'request rejected by the plugin trust fence' } })
        return
      }

      const path = (request.url ?? '').split('?')[0] ?? ''

      if (request.method === 'GET' && path.endsWith('/health')) {
        send(200, { ok: true, value: { mounted: deps.mountedToolNames(), skipped: deps.skippedRoutes() } })
        return
      }

      if (request.method !== 'POST') {
        send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
        return
      }

      if (path.endsWith('/settings.get')) {
        send(200, { ok: true, value: deps.readConfig() })
        return
      }

      if (path.endsWith('/settings.update')) {
        let size = 0
        const chunks: Buffer[] = []
        const body = await new Promise<string | undefined>(resolve => {
          request.on('data', (chunk?: unknown) => {
            const buffer = chunk as Buffer
            size += buffer.length
            if (size > MAX_BODY_BYTES) { resolve(undefined); return }
            chunks.push(buffer)
          })
          request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
        })
        if (body === undefined) {
          send(413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: `body exceeds ${MAX_BODY_BYTES} bytes` } })
          return
        }
        try {
          await deps.writeConfig(JSON.parse(body) as Config)
          send(200, { ok: true, value: deps.readConfig() })
        } catch (error: unknown) {
          send(409, { ok: false, error: { code: 'WRITE_FAILED', message: String(error) } })
        }
        return
      }

      send(404, { ok: false, error: { code: 'UNKNOWN_ROUTE', message: path } })
    },
  })
}
```

- [ ] **Step 3: 跑 http 测试**

Run: `npm run test -- tests/http.test.ts`
Expected: 7 个测试通过。

- [ ] **Step 4: 在 src/index.ts 接入 HTTP 路由**

```ts
  ctx.effect(() => registerCrewApi(ctx, {
    readConfig: () => current,
    writeConfig: async next => {
      const settings = ctx.get('settings')
      if (settings === undefined) throw new Error('no settings provider composed')
      await settings.update(SETTINGS_NAMESPACE, next)
    },
    mountedToolNames: () => coordinator.mountedToolNames(),
    skippedRoutes: () => lastSkipped,
    trustedHosts: [],
  }))
```

`lastSkipped` 在 `onSkipped` 回调中记录一份，供健康路由读取。

- [ ] **Step 5: 客户端 spike**

Run:
```bash
cat ~/.dsh/profiles/web/node_modules/dsh-context/package.json | head -40
ls ~/.dsh/profiles/web/node_modules/dsh-context/lib/
```

确认 `dsh.client` 的字段形状与 `exports["./client"]` 的产物形态，记进报告。

**若与预期不符，停在这里**：交付 Step 1-4 的 HTTP API，跳过 Step 6-8，在报告中写明实测契约。这是设计文档第 11 节预留的退路。

- [ ] **Step 6: 写客户端**

`package.json` 追加：

```json
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
```

devDependencies 追加 `react`、`react-dom`、`@types/react`（版本与 `dsh-context` 实测一致）。

`scripts/build.mjs` 追加第二个构建入口，产出 `lib/client.js`，`external` 同样包含 `@deepseek-ai/*` 与 `react`。

`src/client/api.ts`：

```ts
/** 与 host 侧 fenced 路由通信的最小封装。 */
export interface CrewApiResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * 调用插件自有的 fenced 路由。
 * @param path - `/crew/api` 之后的路径片段。
 * @param body - POST 请求体；省略则发 GET。
 * @returns 服务端返回的结果封装。
 */
export async function callCrewApi<T>(path: string, body?: unknown): Promise<CrewApiResult<T>> {
  const response = await fetch(`/crew/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  return await response.json() as CrewApiResult<T>
}
```

`src/client/CrewSection.tsx`：呈现角色列表（id、启用开关、每个模型的 provider/model、健康状态三态），流水线参数（收敛轮数上限、gate 开关、产物目录），以及一句 KV 缓存提示。读写走 `callCrewApi`。写入失败时保留用户输入并提示重试，不清空表单。

`src/client/index.ts`：注册 `settings.section`。

**这一步没有给出完整代码，这是有意的**：组件的 props 类型与 slots 注册 API 都要等 Step 5 的 spike 实测才能确定，此前写出的任何代码都是猜测。**先把 spike 实测到的契约原样写进报告，再照着它写代码** —— 不要反过来先写代码、再让契约去迁就。

组件行为的验收判据（与契约无关，必须满足）：

- 角色的健康状态显示三态：就绪 / 未配置 / 不存在
- 保存失败时表单内容不丢失
- 界面上有一句提示：修改角色启停会使全部会话的模型缓存前缀失效，下一轮请求需重新预填充
- **不呈现任何凭据字段** —— 本插件不碰凭据，provider 的密钥归 Models 页管

- [ ] **Step 7: 构建并确认产物**

Run: `npm run build && ls -la lib/`
Expected: 同时产出 `lib/index.js` 与 `lib/client.js`。

- [ ] **Step 8: 提交**

```bash
git add src/http.ts src/client/ package.json scripts/build.mjs tests/http.test.ts
git commit -m "feat: fenced HTTP 配置 API 与客户端配置界面

ctx.webServer.register() 不提供鉴权，信任边界自建：Host 精确匹配回环
名单（evil-localhost.com 与 localhost.evil.com 都必须拒绝）、限定方法、
请求体 64KB 上限。GET /health 返回已挂载工具与被跳过路由，补上 headless
下 logger 不可见的可观测性缺口。"
```

---

### Task 9: 真实安装与端到端验收

**Files:**
- Modify: `README.md`

前八个任务的验证都是单元测试与组合测试。本任务在真实 dsh 宿主中安装并使用，覆盖前者结构上无法覆盖的加载与交互路径。

- [ ] **Step 1: 构建并安装到测试 profile**

```bash
npm run build
dsh plugin --profile crewtest add /Users/wangchao/workspace/dsh-dev-crew
```

`crewtest` profile 在阶段一已创建。**不要碰用户日常使用的 `web` profile**。

- [ ] **Step 2: 确认四份 skill 已注册**

```bash
dsh --profile crewtest "列出你当前可用的 skill 名称，只列名字"
```

Expected: 输出含 `crew`、`crew-brainstorm`、`crew-plan`。**`crew-converge` 不应出现在人可见的命令列表里**，但应出现在模型可见的 skill 目录中 —— 如果模型报告里有它，说明 modelInvocable 生效；用 `/` 命令列表确认它不在人可见面。

- [ ] **Step 3: 确认初始化工具可用**

在一个空目录里：

```bash
cd $(mktemp -d) && git init && dsh --profile crewtest "调用 crew_init 创建流程产物目录，然后告诉我创建了哪些"
```

Expected: 报告创建了三个目录；`ls docs/` 确认它们真实存在。再跑一次，应报告全部已存在。

- [ ] **Step 4: 确认纪律 gate 生效**

在上一步的目录里，先启用 implementer 角色（编辑 `~/.dsh/profiles/crewtest/cordis.patch.yml`），然后：

```bash
dsh --profile crewtest "用 subagent_implementer 起一个子任务，让它随便写点什么"
```

Expected: 调用被拒绝，模型收到的理由说明「必须给出 plan 文件路径」。**这是本任务最关键的一条验证** —— gate 是唯一能强制「产物走文件」的机制。

然后创建一个真实的 plan 文件，再试一次：

```bash
echo '# 计划：打印一行字' > docs/plans/2026-08-19-hello.md
dsh --profile crewtest "用 subagent_implementer 起一个子任务，让它读 docs/plans/2026-08-19-hello.md 并按计划做"
```

Expected: 这次调用通过。

- [ ] **Step 5: 确认路径穿越被拒**

```bash
echo 'secret' > /tmp/outside-plan.md
dsh --profile crewtest "用 subagent_implementer 起一个子任务，计划文件在 /tmp/outside-plan.md"
```

Expected: 被拒绝 —— 路径不在 plans 目录之内。

- [ ] **Step 6: 确认配置界面（若 Task 8 未降级）**

```bash
dsh --profile crewtest
```

打开 Web UI，进设置页，确认 Crew 区块存在、能看到角色列表与健康状态、修改后保存生效。若 Task 8 已降级为纯 HTTP API，改为用 curl 验证三条路由：

```bash
curl -s localhost:3080/crew/api/health
curl -s -X POST localhost:3080/crew/api/settings.get
curl -s -H 'Host: evil.com' localhost:3080/crew/api/health   # 应 403
```

- [ ] **Step 7: 更新 README**

补充：四份 skill 的用途与触发方式、`crew_init` 与 `/crew-init`、纪律 gate 的判据与关闭方式、配置界面入口（或 HTTP API，若降级）、以及已知限制的更新（gate 的 `enabled` 变更需重载插件才生效）。

- [ ] **Step 8: 提交**

```bash
git add README.md
git commit -m "docs: 阶段二三的使用说明与已知限制"
```

---

## 完成判据

- `npm run check` 全绿，测试总数不少于 93。
- 四份 skill 在真实宿主中注册成功，`crew-converge` 不出现在人可见的命令面。
- `crew_init` 与 `/crew-init` 均可创建目录且幂等。
- 纪律 gate 在无 plan 路径时拒绝、有合法路径时放行、路径穿越时拒绝。
- 配置界面可用，或已按预留退路降级为 HTTP API 并记录实测契约。

## 遗留与后续

- gate 的 `enabled` 热更新（当前需重载插件）
- `toolFilter` 表达不了「只读 bash」，reviewer 与 researcher 的只读性仍靠 persona
- 同仓库并发跑两轮流水线未支持
