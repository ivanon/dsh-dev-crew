# dsh-dev-crew 阶段一：骨架与角色路由 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出一个能装进 dsh 的 bundle 插件，按配置为每个角色挂载绑定了指定 provider/model 的子代理委派工具，并对不可用的路由拒绝挂载。

**Architecture:** 决策与副作用分离。`health.ts` 与 `mount.ts` 是纯函数，输入 provider 列表与角色配置，输出「该挂哪些工具、跳过哪些及原因」；`index.ts` 的 `apply` 消费这个结果，通过 `ctx.plugin()` 复用官方 `@deepseek-ai/dsh-tool-subagent` 插件工厂完成实际挂载。纯函数承担全部单元测试，真实安装承担端到端验收。

**Tech Stack:** TypeScript、esbuild（bundle 打包，`@deepseek-ai/*` 全部 external）、vitest、Node ^22.19 || >=24。

## Global Constraints

- 包名 `dsh-dev-crew`，`type: module`，ESM only。
- `@deepseek-ai/*` 全部作为 **devDependencies** 并 **pin 到精确版本 `0.1.0-rc.7`**（无 `^`）。运行时由宿主提供，构建时 external。
- **不可使用 `latest` 或 `^` 安装 `@deepseek-ai/dsh-*` 库包**：这些包的 `dist-tags.latest` 指向陈旧的 `0.0.1-rc.1`，实际当前版本线为 `0.1.0-rc.x`。（CLI 包 `@deepseek-ai/dsh` 的 dist-tag 正常，不受此限。）
- **版本必须整条线统一**：`0.1.0-rc.6` 的库包互相声明 `^0.1.0-rc.6` 的 peer 依赖，npm 解析该范围时会取 `rc.7`，而 `rc.7` 又要求其 peer 同为 `rc.7` —— 混用会产生无法解析的 ERESOLVE 冲突。统一 rc.7 后依赖树干净解析（`npm install` 报告 21 个包，其中 `@deepseek-ai/*` 共 19 个），不需要 `--legacy-peer-deps`。
- `@deepseek-ai/cordis` 使用 `^4.0.1`。
- 复用官方插件工厂时**必须传入整个模块命名空间**（`import * as subagentTool`），不可单独传 `apply` —— 后者会丢失 `inject` 声明，导致运行时抛 `cannot get property "subagents" without inject`。
- 子代理后端固定 `spawn`，`backgroundMode` 固定 `continuable`，不提供 fork 选项。
- 内置角色默认 `enabled: false`，默认角色的 `provider`/`model` 为空字符串。
- 工具名规则：单模型角色 `subagent_<role>`，多模型角色 `subagent_<role>_<alias>`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `package.json` | manifest：`dsh.bundle.patch`、exports、依赖 |
| `cordis.patch.yml` | bundle 层，单行 insert 自身 |
| `tsconfig.json` | 类型检查配置，不产出 JS |
| `scripts/build.mjs` | esbuild 构建脚本 |
| `vitest.config.ts` | 测试配置 |
| `src/types.ts` | 共享类型，零依赖 |
| `src/config.ts` | schemastery schema + 内置角色定义 |
| `src/health.ts` | 路由健康判定，纯函数 |
| `src/mount.ts` | 挂载计划推导，纯函数 |
| `src/index.ts` | 插件入口，组装副作用 |
| `tests/health.test.ts` | 健康判定三态 |
| `tests/mount.test.ts` | 挂载计划推导 |
| `tests/config.test.ts` | schema 默认值与校验 |

---

### Task 1: 项目骨架与构建

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `cordis.patch.yml`
- Create: `scripts/build.mjs`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 可构建的包骨架；`src/index.ts` 导出 `name: string` 与 `apply(ctx: Context, config: Config): void`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "dsh-dev-crew",
  "version": "0.1.0",
  "description": "A DeepSeek Harness plugin that runs a development crew: role-bound subagents on different model providers, with an embedded methodology.",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "engines": { "node": "^22.19 || >=24" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "npm run typecheck && npm run test && npm run build"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.7",
    "@deepseek-ai/dsh-llm": "0.1.0-rc.7",
    "@deepseek-ai/dsh-tool-subagent": "0.1.0-rc.7",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.7",
    "@types/node": "^22.15.0",
    "esbuild": "^0.28.2",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    // 源码与测试用 `.ts` 后缀做相对 import（dsh 生态惯例）；NodeNext 下必须
    // 显式开启，否则 tsc 报 TS5097。noEmit 是它的前置条件，已满足。
    "allowImportingTsExtensions": true,
    "strict": true,
    "noImplicitAny": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: 创建 .gitignore**

```
node_modules/
lib/
*.log
.DS_Store
```

- [ ] **Step 4: 创建 cordis.patch.yml**

```yaml
# dsh-dev-crew — bundle patch layer.
#
# 把本包装进 profile（dsh plugin --profile <name> add dsh-dev-crew）会将它
# 追加到 dsh.profile.bundles，此 patch 随即作为该 bundle 的层被应用。
# 下面这一行加载本包主入口作为 host 半部。
- insert:
    - id: dsh-dev-crew
      name: dsh-dev-crew
```

- [ ] **Step 5: 创建 scripts/build.mjs**

```js
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // 宿主提供框架与 harness 包；打进产物会造成两份实例，服务查找失败。
  external: ['@deepseek-ai/*'],
})
```

- [ ] **Step 6: 创建 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 7: 写最小插件入口 src/index.ts**

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-dev-crew'

export function apply(_ctx: Context): void {
  // 角色挂载在 Task 4 接入。
}
```

- [ ] **Step 8: 写 smoke 测试 tests/smoke.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('plugin module', () => {
  it('exports a name and an apply function as named exports', () => {
    expect(plugin.name).toBe('dsh-dev-crew')
    expect(typeof plugin.apply).toBe('function')
  })

  it('has no default export', () => {
    // 默认导出会让 Loader 的 unwrapExports 取 .default 而丢弃 inject 等具名导出。
    expect((plugin as Record<string, unknown>).default).toBeUndefined()
  })
})
```

- [ ] **Step 9: 安装依赖并运行测试**

Run: `cd /Users/wangchao/workspace/dsh-dev-crew && npm install && npm run test`
Expected: 2 个测试通过。

- [ ] **Step 9b: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出。此步骤存在的原因：`package.json` 定义的 `check` 脚本包含
typecheck，一个装好就跑不通的 `check` 是交付缺陷。

- [ ] **Step 10: 验证构建产出**

Run: `npm run build && ls -la lib/`
Expected: 生成 `lib/index.js` 与 `lib/index.js.map`。

- [ ] **Step 11: 验证 external 生效**

Run: `grep -c "@deepseek-ai" lib/index.js`
Expected: 输出 `0`（当前入口尚未 import 任何 harness 包；此步骤建立基线，Task 4 后复查会看到 import 语句而非内联代码）。

- [ ] **Step 12: 提交**

```bash
git add package.json tsconfig.json .gitignore cordis.patch.yml scripts/ vitest.config.ts src/ tests/ package-lock.json
git commit -m "build: 项目骨架、esbuild 构建与 vitest 配置"
```

---

### Task 2: 角色类型与配置 schema

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: Task 1 的包骨架
- Produces:
  - `interface RoleModel { alias: string; provider: string; model: string; maxTokens?: number }`
  - `interface CrewRole { id: string; models: RoleModel[]; persona?: string; toolFilter?: ToolFilter; enabled: boolean }`
  - `interface ToolFilter { allow?: string[]; deny?: string[] }`
  - `interface Config { roles: CrewRole[] }`
  - `const Config: Schema<Config>`
  - `const BUILTIN_ROLES: CrewRole[]`

- [ ] **Step 1: 写失败测试 tests/config.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, Config } from '../src/config.ts'

describe('Config schema', () => {
  it('supplies the three builtin roles when the section is absent', () => {
    const value = new Config({})
    expect(value.roles.map(role => role.id)).toEqual(['implementer', 'reviewer', 'researcher'])
  })

  it('disables every builtin role by default', () => {
    const value = new Config({})
    expect(value.roles.every(role => role.enabled === false)).toBe(true)
  })

  it('leaves builtin provider and model empty so no author-local route ships', () => {
    for (const role of BUILTIN_ROLES) {
      for (const model of role.models) {
        expect(model.provider).toBe('')
        expect(model.model).toBe('')
      }
    }
  })

  it('denies delegation tools to the implementer role', () => {
    const implementer = BUILTIN_ROLES.find(role => role.id === 'implementer')
    expect(implementer?.toolFilter?.deny).toContain('subagent')
  })

  it('accepts a user-supplied role list verbatim', () => {
    const value = new Config({
      roles: [{
        id: 'solo',
        enabled: true,
        models: [{ alias: 'a', provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
      }],
    })
    expect(value.roles).toHaveLength(1)
    expect(value.roles[0]!.models[0]!.model).toBe('deepseek-v4-flash')
  })

  it('leaves an omitted toolFilter undefined instead of materializing an empty one', () => {
    // `allow: []` 的语义是「只保留这零个工具」，即移除全部工具。一个未配置
    // 工具范围的角色若被物化成空过滤器，其子代理会一个工具都拿不到。
    const value = new Config({
      roles: [{
        id: 'solo',
        enabled: true,
        models: [{ alias: 'a', provider: 'p', model: 'm' }],
      }],
    })
    expect(value.roles[0]!.toolFilter).toBeUndefined()
  })

  it('leaves an omitted allow list undefined inside a supplied toolFilter', () => {
    const value = new Config({
      roles: [{
        id: 'solo',
        enabled: true,
        models: [{ alias: 'a', provider: 'p', model: 'm' }],
        toolFilter: { deny: ['subagent'] },
      }],
    })
    expect(value.roles[0]!.toolFilter!.allow).toBeUndefined()
    expect(value.roles[0]!.toolFilter!.deny).toEqual(['subagent'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/config.test.ts`
Expected: FAIL，报错为无法解析 `../src/config.ts`。

- [ ] **Step 3: 写 src/types.ts**

```ts
/** 角色绑定的一个模型路由；每个条目对应一个独立挂载的委派工具。 */
export interface RoleModel {
  /** 工具名后缀，同一角色内唯一。 */
  alias: string
  /** LLM provider 路由键，对应 LlmProviderInfo.id。 */
  provider: string
  /** 模型标识，由 provider 的适配器解释。 */
  model: string
  /** 子代理单次请求的输出上限；省略时沿用适配器默认值。 */
  maxTokens?: number
}

/** 子代理可见的工具范围。 */
export interface ToolFilter {
  /** 保留的全局工具名；给出时其余工具全部移除。 */
  allow?: string[]
  /** 移除的全局工具名。 */
  deny?: string[]
}

/** 一个职责角色及其绑定的模型集合。 */
export interface CrewRole {
  /** 角色标识，构成工具名基底。 */
  id: string
  /** 该角色绑定的模型；每个模型挂载一个工具实例。 */
  models: RoleModel[]
  /** 角色的系统提示词，覆盖部署 persona。 */
  persona?: string
  /** 该角色子代理的工具范围。 */
  toolFilter?: ToolFilter
  /** 是否挂载该角色的工具。 */
  enabled: boolean
}

/** 插件配置。 */
export interface Config {
  roles: CrewRole[]
}
```

- [ ] **Step 4: 写 src/config.ts**

```ts
import Schema from '@deepseek-ai/schemastery'
import type { Config as ConfigType, CrewRole } from './types.ts'

/**
 * 随包分发的三个职责角色。
 *
 * provider 与 model 留空、enabled 为 false：本包面向公开分发，作者本机的
 * provider 路由不存在于使用者机器上，内置具体路由会让每个新用户首次启动
 * 都产生一批不可用的工具。
 */
export const BUILTIN_ROLES: CrewRole[] = [
  {
    id: 'implementer',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You implement one task from an existing written plan. Read the plan file you are given, '
      + 'implement exactly the task you were assigned, and stop. Do not expand scope, do not '
      + 'redesign, and do not start work the plan assigns to another task. Report what you changed '
      + 'and how you verified it.',
    // 移除委派工具：实现者不再向下分派。maxDepth 只限制深度而不限制扇出，
    // 直接移除工具更精确。
    toolFilter: { deny: ['subagent', 'subagent_fork'] },
  },
  {
    id: 'reviewer',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You review an artifact and report findings. You do not modify it: the delegating agent '
      + 'owns every fix. Separate blocking problems (errors, self-contradiction, missing content '
      + 'that would make a later step fail) from non-blocking ones (style, wording, polish), and '
      + 'state which is which. Report that you found nothing when you found nothing.',
    toolFilter: { deny: ['write', 'edit', 'str_replace_editor', 'subagent', 'subagent_fork'] },
  },
  {
    id: 'researcher',
    enabled: false,
    models: [{ alias: 'default', provider: '', model: '' }],
    persona:
      'You investigate a question and report what you found, with sources. You do not modify the '
      + 'repository. Distinguish what you verified from what you inferred.',
    toolFilter: { deny: ['write', 'edit', 'str_replace_editor', 'subagent', 'subagent_fork'] },
  },
]

const RoleModelSchema = Schema.object({
  alias: Schema.string().default('default'),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxTokens: Schema.number(),
})

// 省略必须保持为 undefined。Schemastery 会把未提供的数组字段物化成 `[]`，
// 而 `allow: []` 的语义是「只保留这零个工具」——即移除全部工具，与「未配置
// 工具范围」的意图正好相反。dsh 自身在 tool-subagent 的 Config 中用同样手法
// 规避（原注释：Preserve omission; Schemastery's `{ allow: [] }` default
// would deny every tool）。
const ToolFilterSchema = Schema.object({
  allow: Schema.array(Schema.string()).default(undefined as unknown as string[]),
  deny: Schema.array(Schema.string()).default(undefined as unknown as string[]),
})

const CrewRoleSchema = Schema.object({
  id: Schema.string().required(),
  models: Schema.array(RoleModelSchema).default([]),
  persona: Schema.string(),
  toolFilter: ToolFilterSchema.default(undefined as unknown as ToolFilter),
  enabled: Schema.boolean().default(false),
})

/**
 * `.default(BUILTIN_ROLES)` 的转换目标，由 schema 自身推导而来。
 *
 * Schemastery 的 `ObjectT` 映射把每个声明字段变成必需键，而 `CrewRole` 的
 * `persona` / `toolFilter` 与 `RoleModel` 的 `maxTokens` 是可选的；TypeScript
 * 不允许把可选属性赋给必需属性，因此这一步的转换无法避免。让转换目标由
 * `CrewRoleSchema` 推导而不是手写一份镜像结构，schema 变更时不会静默失配。
 */
type CrewRoleArrayOutput = Schema.TypeT<typeof CrewRoleSchema>[]

/**
 * 输入端 `roles` 可省略（`new Config({})` 取内置角色），输出端始终是完整的
 * `ConfigType`，因此使用双类型参数。单参数的 `Schema<ConfigType>` 会让输入
 * 类型也要求 `roles`，与 `new Config({})` 冲突。
 */
export const Config: Schema<Partial<ConfigType>, ConfigType> = Schema.object({
  roles: Schema.array(CrewRoleSchema).default(BUILTIN_ROLES as unknown as CrewRoleArrayOutput),
})
```

`Schema.TypeT` 的命名空间引用方式以实际编译通过为准；若 schemastery 的类型导出形式不同，改用等价写法，但保持「转换目标由 schema 推导」这一点不变。`import type` 行需要同时引入 `ToolFilter`。

类型标注方式与 dsh 自身插件一致（`packages/subagent/tool-subagent/src/index.ts` 的 `export const Config: z<Config> = z.object({...})`），不使用类型断言：若 schema 与接口不匹配，应当在下一步的 typecheck 中暴露并修正 schema，而不是用断言掩盖。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- tests/config.test.ts`
Expected: 7 个测试通过。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出。

- [ ] **Step 7: 提交**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: 角色类型与配置 schema，含三个默认停用的内置角色"
```

---

### Task 3: 路由健康判定

**Files:**
- Create: `src/health.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不依赖 Task 2 的类型）
- Produces:
  - `type RouteHealth = 'ready' | 'unconfigured' | 'missing'`
  - `function checkRoute(provider: string, live: readonly LiveProvider[], configurable: readonly ConfigurableProvider[]): RouteHealth`
  - `interface LiveProvider { id: string }`
  - `interface ConfigurableProvider { provider: string }`

- [ ] **Step 1: 写失败测试 tests/health.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { checkRoute } from '../src/health.ts'

const live = [{ id: 'deepseek-official' }, { id: 'kimi-coding' }]
const configurable = [{ provider: 'kimi-coding' }, { provider: 'qwen' }]

describe('checkRoute', () => {
  it('reports ready for a registered route', () => {
    expect(checkRoute('deepseek-official', live, configurable)).toBe('ready')
  })

  it('prefers ready over unconfigured when a route appears in both lists', () => {
    // kimi-coding 同时出现在两个列表：已注册即可用，声明状态不改变结论。
    expect(checkRoute('kimi-coding', live, configurable)).toBe('ready')
  })

  it('reports unconfigured for a declared but dormant route', () => {
    expect(checkRoute('qwen', live, configurable)).toBe('unconfigured')
  })

  it('reports missing for a route neither list knows', () => {
    expect(checkRoute('nonexistent', live, configurable)).toBe('missing')
  })

  it('reports missing for an empty provider name', () => {
    // 内置角色的默认空值必须落在 missing，否则默认配置会挂出工具。
    expect(checkRoute('', live, configurable)).toBe('missing')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/health.test.ts`
Expected: FAIL，报错为无法解析 `../src/health.ts`。

- [ ] **Step 3: 写 src/health.ts**

```ts
/**
 * 一个 provider 路由对本插件的可用状态。
 *
 * 判据分别取自 `ctx.llm.listProviders()`（已注册的活路由）与
 * `ctx.llm.listConfigurableProviders()`（声明了但尚未激活的路由）。注意两个
 * 接口的路由键字段名不同：前者是 `id`，后者是 `provider`。
 */
export type RouteHealth = 'ready' | 'unconfigured' | 'missing'

/** `ctx.llm.listProviders()` 条目中本模块关心的字段。 */
export interface LiveProvider {
  id: string
}

/** `ctx.llm.listConfigurableProviders()` 条目中本模块关心的字段。 */
export interface ConfigurableProvider {
  provider: string
}

/**
 * 判定一个 provider 路由的可用状态。
 * @param provider - 待判定的路由键；空字符串一律判为 missing。
 * @param live - 当前已注册的 provider 路由。
 * @param configurable - 已声明可通过配置激活的 provider 路由。
 * @returns 该路由的健康状态。
 */
export function checkRoute(
  provider: string,
  live: readonly LiveProvider[],
  configurable: readonly ConfigurableProvider[],
): RouteHealth {
  if (provider === '') return 'missing'
  if (live.some(entry => entry.id === provider)) return 'ready'
  if (configurable.some(entry => entry.provider === provider)) return 'unconfigured'
  return 'missing'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/health.test.ts`
Expected: 5 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/health.ts tests/health.test.ts
git commit -m "feat: provider 路由健康判定"
```

---

### Task 4: 挂载计划推导与插件接入

**Files:**
- Create: `src/mount.ts`
- Modify: `src/index.ts`
- Test: `tests/mount.test.ts`

**Interfaces:**
- Consumes: `CrewRole`、`Config`（Task 2）；`checkRoute`、`LiveProvider`、`ConfigurableProvider`、`RouteHealth`（Task 3）
- Produces:
  - `interface MountSpec { toolName: string; config: SubagentToolConfig }`
  - `interface SubagentToolConfig { provider: 'spawn'; toolName: string; backgroundMode: 'continuable'; agentOptions: { provider: string; model: string; maxTokens?: number }; persona?: string; toolFilter?: ToolFilter }`
  - `interface SkippedRoute { toolName: string; provider: string; reason: RouteHealth }`
  - `interface MountPlan { specs: MountSpec[]; skipped: SkippedRoute[] }`
  - `function toolNameFor(role: CrewRole, model: RoleModel): string`
  - `function planMounts(roles: readonly CrewRole[], live, configurable): MountPlan`

- [ ] **Step 1: 写失败测试 tests/mount.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { planMounts, toolNameFor } from '../src/mount.ts'
import type { CrewRole } from '../src/types.ts'

const live = [{ id: 'deepseek-official' }, { id: 'kimi-coding' }]
const configurable = [{ provider: 'qwen' }]

function role(partial: Partial<CrewRole> & Pick<CrewRole, 'id' | 'models'>): CrewRole {
  return { enabled: true, ...partial }
}

describe('toolNameFor', () => {
  it('omits the alias suffix for a single-model role', () => {
    const single = role({ id: 'implementer', models: [{ alias: 'default', provider: 'p', model: 'm' }] })
    expect(toolNameFor(single, single.models[0]!)).toBe('subagent_implementer')
  })

  it('appends the alias for a multi-model role', () => {
    const multi = role({
      id: 'reviewer',
      models: [
        { alias: 'ds', provider: 'p', model: 'm' },
        { alias: 'kimi', provider: 'q', model: 'n' },
      ],
    })
    expect(toolNameFor(multi, multi.models[1]!)).toBe('subagent_reviewer_kimi')
  })
})

describe('planMounts', () => {
  it('plans one mount per model of an enabled role with ready routes', () => {
    const roles = [role({
      id: 'reviewer',
      models: [
        { alias: 'ds', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { alias: 'kimi', provider: 'kimi-coding', model: 'k3' },
      ],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs.map(spec => spec.toolName))
      .toEqual(['subagent_reviewer_ds', 'subagent_reviewer_kimi'])
    expect(plan.skipped).toEqual([])
  })

  it('skips a disabled role entirely', () => {
    const roles = [role({
      id: 'implementer',
      enabled: false,
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('skips an unconfigured route and records why', () => {
    const roles = [role({
      id: 'researcher',
      models: [{ alias: 'default', provider: 'qwen', model: 'Qwen3' }],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs).toEqual([])
    expect(plan.skipped).toEqual([
      { toolName: 'subagent_researcher', provider: 'qwen', reason: 'unconfigured' },
    ])
  })

  it('skips a missing route and records why', () => {
    const roles = [role({
      id: 'researcher',
      models: [{ alias: 'default', provider: 'nope', model: 'x' }],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.skipped[0]!.reason).toBe('missing')
  })

  it('mounts the ready models of a role whose other models are not ready', () => {
    const roles = [role({
      id: 'reviewer',
      models: [
        { alias: 'ds', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { alias: 'qw', provider: 'qwen', model: 'Qwen3' },
      ],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs).toHaveLength(1)
    expect(plan.specs[0]!.toolName).toBe('subagent_reviewer_ds')
    expect(plan.skipped).toHaveLength(1)
  })

  it('pins every spec to the spawn backend and continuable mode', () => {
    const roles = [role({
      id: 'implementer',
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
    })]
    const spec = planMounts(roles, live, configurable).specs[0]!
    expect(spec.config.provider).toBe('spawn')
    expect(spec.config.backgroundMode).toBe('continuable')
  })

  it('carries persona, toolFilter and maxTokens into the mount config', () => {
    const roles = [role({
      id: 'implementer',
      persona: 'you implement',
      toolFilter: { deny: ['subagent'] },
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm', maxTokens: 4096 }],
    })]
    const spec = planMounts(roles, live, configurable).specs[0]!
    expect(spec.config.persona).toBe('you implement')
    expect(spec.config.toolFilter).toEqual({ deny: ['subagent'] })
    expect(spec.config.agentOptions.maxTokens).toBe(4096)
  })

  it('omits maxTokens from agentOptions when the model does not set one', () => {
    const roles = [role({
      id: 'implementer',
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
    })]
    const spec = planMounts(roles, live, configurable).specs[0]!
    expect('maxTokens' in spec.config.agentOptions).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/mount.test.ts`
Expected: FAIL，报错为无法解析 `../src/mount.ts`。

- [ ] **Step 3: 写 src/mount.ts**

```ts
import type { ConfigurableProvider, LiveProvider, RouteHealth } from './health.ts'
import { checkRoute } from './health.ts'
import type { CrewRole, RoleModel, ToolFilter } from './types.ts'

/**
 * 传给 `@deepseek-ai/dsh-tool-subagent` 的配置。
 *
 * `provider` 固定为 `spawn`：fork 的前缀复用收益会被 continuable 子代理装入
 * 请求头部的 report 工具与提示词段落抵消，付出复制历史的成本而收益归零。
 */
export interface SubagentToolConfig {
  provider: 'spawn'
  toolName: string
  backgroundMode: 'continuable'
  agentOptions: { provider: string; model: string; maxTokens?: number }
  persona?: string
  toolFilter?: ToolFilter
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

/**
 * 推导挂载计划：哪些工具该挂，哪些因路由不可用被跳过。
 *
 * 停用的角色既不挂载也不记入 skipped —— 那是用户的选择，不是配置问题。
 * @param roles - 配置中的角色列表。
 * @param live - 当前已注册的 provider 路由。
 * @param configurable - 已声明可通过配置激活的 provider 路由。
 * @returns 待挂载实例与被跳过实例。
 */
export function planMounts(
  roles: readonly CrewRole[],
  live: readonly LiveProvider[],
  configurable: readonly ConfigurableProvider[],
): MountPlan {
  const specs: MountSpec[] = []
  const skipped: SkippedRoute[] = []

  for (const role of roles) {
    if (!role.enabled) continue
    for (const model of role.models) {
      const toolName = toolNameFor(role, model)
      const health = checkRoute(model.provider, live, configurable)
      if (health !== 'ready') {
        skipped.push({ toolName, provider: model.provider, reason: health })
        continue
      }
      specs.push({
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
          ...role.persona === undefined ? {} : { persona: role.persona },
          ...role.toolFilter === undefined ? {} : { toolFilter: role.toolFilter },
        },
      })
    }
  }

  return { specs, skipped }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/mount.test.ts`
Expected: 10 个测试通过（`toolNameFor` 2 个，`planMounts` 8 个）。

- [ ] **Step 5: 改写 src/index.ts 接入挂载**

```ts
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
```

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出。若 `ctx.llm` 或 `ctx.logger` 报未知属性，确认 `@deepseek-ai/dsh-llm` 已在 devDependencies 中且被 `inject` 声明覆盖。

- [ ] **Step 7: 全量测试与构建**

Run: `npm run check`
Expected: typecheck 通过、24 个测试通过（smoke 2 + config 7 + health 5 + mount 10）、构建产出 `lib/index.js`。

- [ ] **Step 8: 复查 external 生效**

Run: `grep -n "@deepseek-ai/dsh-tool-subagent" lib/index.js`
Expected: 出现 `import ... from "@deepseek-ai/dsh-tool-subagent"` 一行 —— 是保留的 import 语句而非被内联的实现。

- [ ] **Step 9: 提交**

```bash
git add src/mount.ts src/index.ts tests/mount.test.ts
git commit -m "feat: 按角色配置挂载子代理委派工具，跳过不可用路由"
```

---

### Task 5: 跟随 provider 拓扑变化重新挂载

**Files:**
- Modify: `src/mount.ts`（追加 `diffMounts`）
- Modify: `src/index.ts`（改为可重入的 sync）
- Modify: `tests/mount.test.ts`（追加 `diffMounts` 用例）

**Interfaces:**
- Consumes: `MountSpec`、`planMounts`（Task 4）
- Produces: `interface MountDiff { toAdd: MountSpec[]; toRemove: string[] }`；`function diffMounts(current: readonly MountSpec[], next: readonly MountSpec[]): MountDiff`

用户在 Models 设置页配好一个此前休眠的 provider 后，对应角色的工具应当出现，而不必重启 dsh。`llm/adapters-updated` 是每个路由注册或注销后发出的无载荷通知，消费者据此重新读取而非轮询。

- [ ] **Step 1: 在 tests/mount.test.ts 末尾追加失败测试**

```ts
import { diffMounts } from '../src/mount.ts'

describe('diffMounts', () => {
  const specA = {
    toolName: 'subagent_a',
    config: {
      provider: 'spawn' as const,
      toolName: 'subagent_a',
      backgroundMode: 'continuable' as const,
      agentOptions: { provider: 'p', model: 'm' },
    },
  }
  const specB = { ...specA, toolName: 'subagent_b', config: { ...specA.config, toolName: 'subagent_b' } }

  it('adds a spec that is not currently mounted', () => {
    expect(diffMounts([], [specA])).toEqual({ toAdd: [specA], toRemove: [] })
  })

  it('removes a mounted spec that is no longer planned', () => {
    expect(diffMounts([specA], [])).toEqual({ toAdd: [], toRemove: ['subagent_a'] })
  })

  it('does nothing when the plan is unchanged', () => {
    expect(diffMounts([specA], [specA])).toEqual({ toAdd: [], toRemove: [] })
  })

  it('remounts a spec whose config changed under the same tool name', () => {
    const changed = { ...specA, config: { ...specA.config, agentOptions: { provider: 'p', model: 'other' } } }
    expect(diffMounts([specA], [changed]))
      .toEqual({ toAdd: [changed], toRemove: ['subagent_a'] })
  })

  it('handles simultaneous add and remove', () => {
    expect(diffMounts([specA], [specB])).toEqual({ toAdd: [specB], toRemove: ['subagent_a'] })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/mount.test.ts`
Expected: FAIL，报错为 `diffMounts` 未从 `../src/mount.ts` 导出。

- [ ] **Step 3: 在 src/mount.ts 末尾追加实现**

```ts
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
```

`JSON.stringify` 在此处足以判等：`SubagentToolConfig` 是纯数据，字段由 `planMounts` 按固定顺序构造，同一输入产生同一字符串。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/mount.test.ts`
Expected: 15 个测试通过（`toolNameFor` 2 + `planMounts` 8 + `diffMounts` 5）。

- [ ] **Step 5: 改写 src/index.ts 为可重入的 sync**

```ts
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
```

- [ ] **Step 6: 类型检查与全量测试**

Run: `npm run check`
Expected: typecheck 通过、29 个测试通过（smoke 2 + config 7 + health 5 + mount 15）、构建成功。

若 `ctx.on('llm/adapters-updated', ...)` 报事件名未知，确认 `@deepseek-ai/dsh-llm` 在 devDependencies 中 —— 该事件通过声明合并加入事件映射，需要该包的类型在编译范围内。

- [ ] **Step 7: 提交**

```bash
git add src/mount.ts src/index.ts tests/mount.test.ts
git commit -m "feat: 跟随 llm/adapters-updated 重新挂载角色工具"
```

---

### Task 6: 真实安装与端到端验收

**Files:**
- Create: `README.md`
- Modify: 无源码改动

**Interfaces:**
- Consumes: Task 1–5 的完整插件
- Produces: 可安装、可在真实 dsh 中派发子代理的插件；README 安装与配置说明

本任务的验证是在真实 dsh 宿主中安装并观察，不是单元测试。dsh 的 ACP 事故记录表明单元测试全绿仍可能在真实加载路径上崩溃，此步骤覆盖的正是该路径。

- [ ] **Step 1: 构建当前代码**

Run: `cd /Users/wangchao/workspace/dsh-dev-crew && npm run build`
Expected: `lib/index.js` 更新。

- [ ] **Step 2: 安装到一个隔离的测试 profile**

Run: `dsh plugin --profile crewtest add /Users/wangchao/workspace/dsh-dev-crew`
Expected: profile 初始化成功，输出显示 `dsh-dev-crew` 被追加到 bundles。

使用独立的 `crewtest` profile 而非日常使用的 `web`，避免测试中的插件影响日常工作环境。

- [ ] **Step 3: 验证 bundle 层被识别**

Run: `dsh --profile crewtest --dump-config | grep -A 3 "dsh-dev-crew"`
Expected: 输出包含 `# == dsh-dev-crew` 层标记，以及 `- id: dsh-dev-crew` 与 `name: dsh-dev-crew` 两行。

若无输出，说明 `dsh.bundle.patch` 声明未被识别，检查 `package.json` 的 `dsh` 字段与 `cordis.patch.yml` 是否都在 `files` 中。

- [ ] **Step 4: 理解 `--dump-config` 能验证什么、不能验证什么**

`--dump-config` 渲染的是**静态配置树**：profile 的 bundle 层按顺序 patch 出来的行。本插件的角色工具是在 `apply()` 里通过运行时 `ctx.plugin()` 挂载的，**不进入这棵树**，因此 `--dump-config` 对角色的启停完全不敏感——角色开、关、路由失效三种状态下它的输出完全一样。

所以 Step 3 的用途仅限于确认「bundle 层被识别、插件行被插入」。**角色工具是否真的挂载，只能由 Step 6/7 的真实模型问答验证**，没有静态替代品。

不要用 `grep -c "tool-subagent"` 之类的计数作为角色挂载的判据：它数的是 base bundle 自带的静态行，与本插件的运行时挂载无关。

- [ ] **Step 5: 启用一个角色**

编辑 `~/.dsh/profiles/crewtest/cordis.patch.yml`，追加以下内容。`provider` 与 `model` 替换为本机 Models 设置页中已就绪的一组值：

```yaml
- id: dsh-dev-crew
  config:
    roles:
      - id: implementer
        enabled: true
        models:
          - alias: default
            provider: deepseek-official
            model: deepseek-v4-flash
        persona: >-
          You implement one task from an existing written plan. Read the plan file you are
          given, implement exactly the task you were assigned, and stop.
        toolFilter:
          deny: [subagent, subagent_fork]
```

注意 patch 替换整个 `config` 而不做深合并，因此这里必须给出完整的 `roles` 列表。

- [ ] **Step 6: 启动并确认工具出现**

Run: `dsh --profile crewtest`

在会话中输入：`列出你当前可用的工具名`

Expected: 模型的回答中包含 `subagent_implementer`。

- [ ] **Step 7: 实际派发一次子代理**

在同一会话中输入：`用 subagent_implementer 起一个子任务，让它回答 1+1 等于几，并把它的回答告诉我`

Expected: 主代理调用 `subagent_implementer`；Web 界面的会话头部出现子代理树，其中一行处于 running 后转为 inactive；主代理最终报告子代理的回答。

- [ ] **Step 8: 验证路由不可用时不挂载**

把 Step 5 中的 `provider` 改为 `nonexistent-provider`，重启 dsh。

Expected: 启动日志出现一行警告 `subagent_implementer not mounted: provider "nonexistent-provider" is not registered by any adapter`；会话中询问工具列表时 `subagent_implementer` 不存在。

- [ ] **Step 9: 验证配置好 provider 后工具自动出现**

保持 dsh 运行，在 Models 设置页配置一个此前处于「未配置」状态的 provider（若本机没有这样的 provider，把 Step 5 的 `provider` 先改成一个已声明但未配置的路由并重启，再执行本步）。

Expected: 无需重启，会话中再次询问工具列表时对应的 `subagent_<role>` 工具已经出现 —— `llm/adapters-updated` 触发了重新挂载。

- [ ] **Step 10: 写 README.md**

```markdown
# dsh-dev-crew

一个 DeepSeek Harness 插件：按职责把工作分派给绑定了不同模型的子代理。

需求整理与评审交给强模型，批量实现交给低成本模型，全部在同一个会话内完成。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-dev-crew
```

## 配置

在 profile 的 `cordis.patch.yml` 中配置角色。每个角色可绑定一个或多个模型，
每个模型对应一个独立的委派工具。

```yaml
- id: dsh-dev-crew
  config:
    roles:
      - id: implementer
        enabled: true
        models:
          - alias: default
            provider: deepseek-official
            model: deepseek-v4-flash
      - id: reviewer
        enabled: true
        models:
          - alias: ds
            provider: deepseek-official
            model: deepseek-v4-flash
          - alias: kimi
            provider: kimi-coding
            model: k3
```

工具名规则：单模型角色为 `subagent_<角色名>`，多模型角色为
`subagent_<角色名>_<alias>`。上面的配置会挂出 `subagent_implementer`、
`subagent_reviewer_ds`、`subagent_reviewer_kimi` 三个工具。

`provider` 必须是 Models 设置页中已就绪的路由。未配置或不存在的路由不会挂载
工具，启动时会有一行说明原因的警告。

内置三个角色 `implementer` / `reviewer` / `researcher`，各自带有写好的 persona
与工具范围，默认全部停用 —— 因为路由取决于你自己配置了哪些 provider。

## 已知限制

- 角色的启停会改变工具集，使全部会话的模型缓存前缀失效，下一轮请求需重新预填充。
- 子代理后端固定为 `spawn`（干净上下文）。不提供 fork：fork 的前缀复用收益会被
  continuable 子代理装入请求头部的内容抵消。

## 许可

MIT
```

- [ ] **Step 11: 提交**

```bash
git add README.md
git commit -m "docs: 安装、角色配置与已知限制说明"
```

---

## 阶段一完成判据

- `npm run check` 全绿。
- 插件可通过 `dsh plugin add` 装入 profile，`--dump-config` 能看到其 bundle 层。
- 启用角色并配置就绪路由后，对应的 `subagent_<role>` 工具出现在模型的工具列表中，且能实际派发子代理。
- 配置不可用的路由时不挂载工具，并输出说明原因的警告。

## 后续阶段

- **阶段二**：四份方法论 skill 正文、流程产物目录初始化、`tools/pre-execute` 纪律 gate。
- **阶段三**：配置界面（`settings.section` + 自带信任边界的 HTTP 路由）。

两个阶段各自另立计划。
