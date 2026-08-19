# dsh-dev-crew 设计文档

> 状态：阶段一已实现并合入；阶段二、三待实施
> 日期：2026-08-19
> 目标运行时：DeepSeek Harness（dsh）0.1.0-rc.7
>
> 阶段一（第 3 节角色路由 + 第 8 节包形态）已交付，41 个测试，端到端验收通过。
> 实施过程中查证出的上游事实与由此产生的约束记录在
> [docs/notes/2026-08-19-phase-1-outcome.md](../notes/2026-08-19-phase-1-outcome.md)，
> 其中影响后续设计的部分已回填进本文档相应章节。

---

## 1. 目标与边界

### 1.1 产品定义

一个 dsh 插件（bundle），把「需求讨论 → 计划 → 分派实现 → 多轮评审收敛 → 汇总报告」的开发流水线变成装上即用的能力。

装上之后用户得到四样东西：一支绑定了不同模型的角色小队、一套内嵌的方法论、一个流程产物目录的初始化入口、一个配置界面。

### 1.2 解决的问题

同一个会话里，不同职责应该跑在不同成本的模型上：需求整理和评审需要强模型，批量写代码用低成本模型即可。dsh 原生支持这种路由，但需要手工编写配置，且路由决策无法随方法论一起分发。

### 1.3 边界

**做**：角色路由、方法论 skill、流程产物目录初始化、配置界面、纪律 gate。

**不做**：

- 不规定用户项目的 `src/` 等业务代码结构。技术栈差异过大，任何强制结构都会与既有项目冲突。
- 不写用户项目的 `AGENTS.md`。dsh 的 context 插件会把该文件喂给模型，插件单方面追加内容等于改写用户每个会话的 system prompt。
- 不接外部 CLI（cursor / kimi 一类）。评审者由 dsh 自己的子代理担任，避免把外部工具的安装状态变成插件的运行前提。
- 不做 token 预算统计。Web UI 的子代理树已免费提供每个子代理的累计用量。

---

## 2. 流水线

```
1. 需求讨论 ──────── 唯一人工环节，落盘 docs/specs/<date>-<topic>.md
2. 预检门 ────────── 路由健康 + git 工作区干净 + 产物目录可写；任一不满足即中止
3. spec 评审 ──────┐
4. 写实施计划 ──────│ 收敛协议（见 3.3）
5. plan 评审 ──────│ 落盘 docs/plans/<date>-<topic>.md
6. 逐任务实现 ──────│ 按 plan 派发 implementer，每个 task 一个子代理
7. 代码评审 ────────┘ 对象为 $BASE..HEAD
8. 最终报告 ──────── 落盘 docs/reports/
```

步骤 6 开始前记录基线 `BASE=$(git rev-parse HEAD)`，步骤 7 的差异评审以 `$BASE..HEAD` 为范围。

### 2.1 人工介入点

需求讨论是唯一需要用户输入的环节。spec 落盘后到最终报告之间，流程不索要用户输入。

零打扰不等于黑盒：用户可在 Web UI 的子代理树上实时查看每个子代理的运行状态、累计 token 与完整 transcript，并可随时中断。

### 2.2 产物走文件，不走上下文

子代理之间传递产物一律通过文件路径，不把产物全文放回主代理的对话。

这是主代理上下文预算的核心约束。整条流水线在一个会话内完成，主代理要经历需求讨论、多轮评审、逐任务派发与汇总；若每份 spec、plan、评审报告都以全文形式回到对话，上下文会在流水线中段耗尽。让主代理只持有路径与结论，产物留在磁盘，是这条流水线能跑完的前提。

第 6 节的纪律 gate 把这条约束变成硬性检查。

### 2.3 打回重做不重跑整轮

评审子代理以 `backgroundMode: continuable` 启动，修复后通过 `send_message` 在同一子会话内要求复审。评审者保留上一轮的上下文，复审只需读取变更部分，比重新启动一个子代理全量复审更快且更省 token。

---

## 3. 角色模型与路由

### 3.1 角色定义

```ts
interface CrewRole {
  id: string                    // 工具名基底
  models: RoleModel[]           // 该角色绑定的模型；每个模型挂一个工具实例
  persona?: string              // 角色的系统提示词，覆盖部署 persona
  toolFilter?: { allow?: string[]; deny?: string[] }
  enabled: boolean
}

interface RoleModel {
  alias: string                 // 工具名后缀，同一角色内唯一
  provider: string              // LLM provider 路由
  model: string
  maxTokens?: number
}
```

工具名规则：单模型角色为 `subagent_<role>`，多模型角色为 `subagent_<role>_<alias>`。

### 3.2 内置三角色

| 角色 | 定位 | 模型取向 | toolFilter |
|---|---|---|---|
| `implementer` | 按 plan 写代码 | 低成本、高吞吐 | 允许读写与 bash；**deny 掉全部子代理派发工具** |
| `reviewer` | 评审产物 | 强模型 | 只读：文件读取、检索、只读 bash；**deny 写入类工具** |
| `researcher` | 调研与资料收集 | 中等 | 读取 + web；deny 写入 |

implementer 的 deny 是防递归的主要手段。`maxDepth`（默认 3）是兜底，但它只限制深度不限制扇出；直接移除派发工具更精确。

reviewer 的只读约束是规格的一部分：评审者不应修改被评审的产物，修复由主代理执行。

角色定义可改绑定、可增删自定义角色。

**关于「角色比纯 alias 更有区分度」的修正（阶段一实施后查证）**：本节原先的论证是「三个工具的 `description` 各不相同，模型能够判断该用哪个」。**该论证不成立**。`dsh-tool-subagent` 的 `description` 只由 provider 种类（spawn / fork）与 `backgroundMode` 决定，不含 `persona`、不含 `toolName`，Config 中也没有 `description` 字段可覆盖 —— 所有角色工具在模型看到的清单里描述逐字节相同，只有名字不同。

固定角色的价值因此收窄为两条仍然成立的理由：工具名本身具备自描述性（`subagent_reviewer` 比 `subagent_r1` 更易被正确选择），以及方法论 skill 可以引用**稳定的工具名**（纯 alias 路由表下 skill 无法写死工具名，因为用户可能没建那个 alias）。

**由此产生的硬性约束**：路由指令必须由 skill 正文承担。第 4 节的 `crew` skill 必须显式规定每一步调用哪个工具，不能指望模型从工具描述里分辨。若要真正的差异化描述，需要为上游 `dsh-tool-subagent` 增加 `description` 配置项。

**内置角色的 persona 与 toolFilter 如何到达子代理**（阶段一实现）：schema 的 `roles` 数组默认值是整体替换而非按 id 合并，因此 `planMounts` 按 `id` 用内置模板填充用户未提供的 `persona` 与 `toolFilter`；用户显式提供的值整体优先，不做深合并。用户只需写 `id` + `models` + `enabled`。

### 3.3 收敛协议与多评审者

supermode 的核心规格是「多个异构评审视角并行，编排者不得兼任评审者」。本设计以「一个 reviewer 角色 + 一个模型列表」实现：

```yaml
reviewer:
  models:
    - { alias: ds,   provider: deepseek-official, model: deepseek-v4-flash }
    - { alias: kimi, provider: kimi-coding,       model: k3 }
```

插件为每个模型挂载一个工具实例（`subagent_reviewer_ds`、`subagent_reviewer_kimi`）。收敛协议 skill 要求在同一条助手消息里并行调用该角色的全部工具实例。

这样处理的三个理由：

- 评审者数量是配置项。一个、两个、三个都成立，不需要为「双评审」硬编码两个角色。
- 「编排者不得兼任」自然成立：主代理除这些工具外没有其他评审途径。
- 收敛判据（全部评审者均无阻塞问题）与评审者数量解耦。

收敛流程：并行发起 → 将意见分为阻塞与非阻塞 → 有阻塞且未达轮数上限则修复并 `send_message` 复审 → 达到上限则转为遗留问题清单并在最终报告中标注。轮数上限是配置项。

对评审意见保持技术判断：意见可能是错的，驳回时记录理由，被驳回的意见不计入阻塞。

### 3.4 子代理后端固定为 spawn

不提供 fork 选项。

fork 的唯一价值是复用父会话的前缀以节省预填充，但 `continuable` 子代理会在继承历史之前插入 `report` 工具 schema 与 `tool:report` 提示词段落，二者都位于请求头部，导致前缀复用在第一个不同字节处中断 —— fork 付出了复制整份 transcript 的 token 成本而收益归零。dsh 官方因此将所有随附组合中的 fork 委派工具绑定为 `one-shot`。

本流水线的分派场景本就应使用干净上下文加显式的 plan 文件路径，spawn 是正确选择。

### 3.5 路由健康检查

挂载前校验角色绑定的 provider 是否可用：

| 状态 | 判据 | 行为 |
|---|---|---|
| 就绪 | 出现在 `ctx.llm.listProviders()` | 挂载工具 |
| 未配置 | 仅出现在 `ctx.llm.listConfigurableProviders()` | 不挂载，界面提示前往 Models 页配置 |
| 不存在 | 两处均无 | 不挂载，记录配置错误 |

监听 `llm/adapters-updated` 事件重新评估，不轮询。

不挂载优于挂载一个调用即失败的工具：后者会让模型反复重试、消耗轮次，且失败原因对用户不可诊断。

**默认路由表为空，三个内置角色默认 `enabled: false`。** 插件面向公开分发，作者本机的 provider 不存在于用户机器上；内置具体的 provider 名会让每个新用户的首次启动都产生一批不可用的工具。

### 3.6 角色数量的代价

每个启用的模型实例对应一份工具 schema 进入请求头部。角色过多有两项代价：工具描述相似度上升导致模型选择准确率下降；任何角色的启停都会使全部会话的 KV 缓存前缀失效。

配置界面需就后者给出明确提示：保存配置的实际代价是下一轮请求全量重新预填充。

---

## 4. 内嵌 skill

四个 skill，全部由插件通过 `ctx.skills.register()` 以运行时内嵌形式注册，随包分发。

| skill | 内容 | 可调用方 |
|---|---|---|
| `crew` | 主编排：触发条件、预检门、八步流水线、失败处理、红旗清单、报告格式 | 模型 + 用户 |
| `crew-brainstorm` | 需求讨论方法，落盘 `docs/specs/` | 模型 + 用户 |
| `crew-plan` | 由 spec 产出实施计划，落盘 `docs/plans/` | 模型 + 用户 |
| `crew-converge` | 收敛协议，被三个评审环节共用 | 仅模型 |

`crew-converge` 仅对模型可见：它是流水线内部机制，用户单独唤起没有意义。dsh 的 `SkillInvocationPolicy` 提供 `modelInvocable` 与 `userInvocable` 两个独立开关，正好表达这一区别。

### 4.1 为何内嵌而非依赖外部 skill

dsh 的 `SkillDefinition` 只有 `name`、`description`、`whenToUse`、`content`、`invocation`、`metadata` 六个字段，不存在依赖声明机制。

dsh 的 skill 发现根为 `<project>/.dsh/skills`、`<project>/.agents/skills`、配置的 `customSkillDirs`、`~/.dsh/skills`、`~/.agents/skills`。Claude Code 生态的 skill 插件安装在 `~/.claude/plugins/` 下，不在任何一个发现根内，无法被 dsh 解析。

内嵌注册使方法论随包分发，不依赖任何目录扫描或路径解析。

### 4.2 方法论文本自行编写

`crew-brainstorm` 与 `crew-plan` 的方法受 [superpowers](https://github.com/obra/superpowers)（MIT, Jesse Vincent）启发，文本自行编写，不复制上游。

上游文本面向 Claude Code 编写，正文中包含 dsh 不存在的引用（其他 skill 名、浏览器可视化伴随工具等），复制过来会给模型一批无法执行的指令；其产物路径与本流水线的目录约定不同；且本流水线需要接管其收尾动作，复制意味着长期维护「他人文本加本地补丁」。

保留的方法：一次只问一个问题、先探索项目上下文、提出 2–3 个方案并给出推荐、分节呈现分节确认、产物落盘后自检（占位符、自相矛盾、歧义、范围）、用户确认后进入下一步。

### 4.3 skill 数量克制

skill 目录会进入 system prompt，每个 skill 的名称、描述与适用说明常驻。四个是设计上限，再增加应先考虑合并。

### 4.4 命名与覆盖

统一使用 `crew-` 前缀。dsh 中同名 skill 先注册者胜，前缀避免与用户既有 skill 冲突；用户若要覆盖某个 skill，在 `~/.dsh/skills/crew-plan/SKILL.md` 放置同名文件即可 —— 这是特性而非缺陷。

---

## 5. 项目初始化

创建流程产物目录：

```
docs/
├── specs/      需求讨论产物
├── plans/      实施计划产物
└── reports/    最终报告
```

报告落盘的理由：会话关闭后，最终报告是流水线唯一的持久证据。

三条纪律：

- **幂等**。目录已存在则跳过，永不覆盖任何已有文件。
- **不触碰用户的 agent 指令文件**（见 1.3）。目录约定写在插件自己的 skill 内。
- **路径可配置**。`docs/specs` 等仅为默认值，用户项目可能已有其他文档布局。

形态为一份实现、两个入口：模型可调用的工具（流水线运行到需要时自行创建）与用户可调用的命令（主动初始化）。

---

## 6. 纪律 gate

在 `tools/pre-execute` 上注册一个 waterfall 监听器，判据为：

> 调用 implementer 角色的工具时，`prompt` 参数中必须包含至少一个可解析且真实存在的、位于配置的 plans 目录下的文件路径。

不满足则返回 `{ kind: 'deny', reason }`，理由回传给模型：implementer 必须收到 plan 文件路径，请先产出计划再分派。

这一条判据同时强制两件事：产物必须落盘（无 plan 文件则无法通过），以及分派时必须传递路径而非全文（第 2.2 节的约束）。

判据不采用「plans 目录下是否存在文件」：那样模型可以拿一份过期的旧计划通过检查，而 gate 的目的是保证本次分派确有对应的计划。

gate 可通过配置关闭。deny 的理由文本回到模型，模型能够据此自行纠正，因此这是一个引导性约束而非硬性拦截。

---

## 7. 配置界面

在 dsh 设置页注册一个区块（`settings.section`）：

```
角色小队
  implementer   [provider ▾] [model ▾]                ● 就绪
  reviewer      [+ 添加模型]
    ├ ds    deepseek-official / deepseek-v4-flash     ● 就绪
    └ kimi  kimi-coding / k3                          ⚠ 未配置 → 前往 Models 页
  researcher    [provider ▾] [model ▾]                ○ 未启用

流水线
  收敛轮数上限     [3]
  纪律 gate        [开 / 关]
  产物目录         docs/specs   docs/plans   docs/reports

提示：修改角色启停会使全部会话的模型缓存前缀失效，下一轮请求需重新预填充。
```

状态三态对应 3.5 节的健康检查结果。

### 7.1 配置读写通道

插件自有的配置命名空间不在 dsh settings RPC 的服务端白名单内，需由插件自己的 HTTP 路由读写。

`ctx.webServer.register({ kind: 'prefix', path, handler })` 是官方服务并返回 disposer，但**它不提供任何鉴权**。信任边界需插件自行实现：校验 Host 头为回环地址（localhost / 127.0.0.1 / ::1）或显式配置的可信主机，其余返回 403。请求体大小需设上限。

配置持久化使用 `ctx.settings.register(ns, schema, { base, applies })`，以 `applies: 'live'` 声明即时生效，通过 `scope.watch()` 在配置变更时重新挂载角色工具。写路径带 revision 守卫，冲突时提示用户刷新重试。

---

## 8. 包形态与发布

### 8.1 目录结构

```
dsh-dev-crew/
├── package.json          # dsh.bundle.patch + dsh.client + exports
├── cordis.patch.yml      # 单行 insert：插件自身
├── src/
│   ├── index.ts          # host：角色挂载、skill 注册、gate、settings、HTTP 路由
│   ├── roles.ts          # 内置角色定义
│   ├── skills/           # 四份方法论正文，构建时内联
│   ├── gate.ts
│   ├── shared.ts         # host / client 共享类型，不含 schemastery 依赖
│   └── client/           # 配置界面
├── docs/specs/           # 本文档所在位置
└── lib/                  # 构建产物，随包发布
```

### 8.2 manifest

```json
{
  "name": "dsh-dev-crew",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": true
  }
}
```

`dsh.bundle.patch` 是 dsh 识别 bundle 的唯一判据；`dsh.client` 使 dsh 的客户端模块服务扫描并托管 `exports["./client"]` 的构建产物。

dsh 对包名无强制要求。`dsh-` 前缀为社区约定，`@deepseek-ai/*` 为官方 scope 不应占用。

### 8.3 发布形态：npm 预构建

`lib/` 在发布时已构建完毕，用户 `dsh plugin --profile <name> add dsh-dev-crew` 即可安装。

不采用 GitHub 直装：git 安装只获取源码而不执行构建脚本，TypeScript 包到用户机器上没有 `lib/` 会直接加载失败。改用 `prepare` 脚本则要求用户在 profile 的 `pnpm-workspace.yaml` 中手动 `allowBuilds`，且首次 `add` 必然失败 —— 该授权的实质是允许在用户机器上、于代理沙箱之外执行本包代码，不应成为公开分发的前置条件。

### 8.4 patch 层与用户覆盖

插件的 patch 层位于 `@deepseek-ai/dsh-base` 之后，可以依赖 base 提供的服务与行（`subagent`、spawn provider 等在其中）。

用户可在自己 profile 的 `cordis.patch.yml` 中按 id 覆盖本插件的行，但 patch 替换整个 `config` 而非深合并，覆盖时须重述全部字段。因此配置默认值应选择用户大概率保留的值，其余交由 schema 承载。

### 8.5 插件市场

发布至 dshmarket 前需确认其自身的命名与元数据要求，那是 dsh 核心契约之外的约定。dsh 官方 manifest 只有 `dsh.bundle` 与 `dsh.profile` 两个字段。

---

## 9. 测试策略

| 对象 | 方式 |
|---|---|
| 路由健康检查 | 单元测试：provider 就绪 / 未配置 / 不存在三态各自的挂载结果 |
| gate 判据 | 单元测试：无路径拒绝、路径不存在拒绝、路径存在放行、gate 关闭时放行 |
| 角色工具挂载 | **真实 Loader 组合测试**：以测试专用 `cordis.yml` 启动，断言工具确实注册、fiber dispose 后确实消失 |
| skill 注册 | 断言 `ctx.skills.list()` 含四个 skill 且 invocation 策略正确 |
| 初始化幂等 | 单元测试：已有目录与已有文件不被覆盖 |
| 配置变更重挂载 | `scope.watch()` 触发后新工具出现、旧工具消失 |

真实 Loader 组合测试是其中最关键的一项。dsh 的 ACP 事故记录（`docs/postmortem/0001-acp-default-export-drops-inject.md`）表明：178 个单元测试全部通过、行覆盖率 100%，接入真实客户端仍立即崩溃，因为所有测试都绕过了插件真正的加载路径。

---

## 10. 关键技术依据

以下事实均在 deepseek-harness 源码中核实。

| 事实 | 依据 |
|---|---|
| 子代理请求可覆盖父代理的 provider/model | `packages/subagent/subagent/src/child-agent.ts` 的 `resolveChildAgentOptions()`，以 `...requested` 覆盖父路由 |
| 委派工具支持挂载时绑定 `agentOptions` | `packages/subagent/tool-subagent/src/index.ts` 的 `Config`，含 `provider`/`toolName`/`backgroundMode`/`agentOptions`/`persona`/`toolFilter`/`maxDepth` |
| 委派工具的模型可见参数仅三个 | 同上，`description`/`prompt`/`run_in_background`；provider 与 model 不是每次调用的参数 |
| spawn provider 支持 persona 与 toolFilter | `packages/subagent/subagent-spawn-in-process/README.md`，能力集为 `{ outputSchema, depthLimit, toolFilter, persona }` |
| fork + continuable 破坏前缀复用 | `.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md` |
| skill 可运行时内嵌注册 | `packages/skill/skill/README.md` 的 `ctx.skills.register()`，返回 Cordis disposer |
| skill 无依赖声明字段 | `packages/skill/skill/src/index.ts` 的 `SkillDefinition` |
| provider 健康查询与变更事件 | `packages/llm/llm/README.md` 的 `listProviders()`、`listConfigurableProviders()`、`llm/adapters-updated` |
| 工具拦截点与拒绝形式 | `docs/cookbook/extension-cookbook.md` 的 `tools/pre-execute` waterfall，返回 `{ kind: 'deny', reason }` |
| bundle 与 profile 的 manifest 契约 | `docs/user/develop/basic/publish.md` |
| 客户端半部的托管机制 | `packages/client/modules/README.md`，扫描 `dsh.client` 并解析 `exports["./client"]` |
| HTTP 路由注册 | `packages/host/webserver/README.md` 的 `ctx.webServer.register()` |
| 函数插件必须整体传递 | `docs/postmortem/0001-acp-default-export-drops-inject.md`；复用官方插件工厂时须传入整个模块命名空间，单独传 `apply` 会丢失 `inject` |

---

## 11. 未决问题

- **skill 正文尚未撰写**。四份方法论文本是本产品的核心资产，篇幅与质量决定产品价值，需在实施阶段逐份撰写并验证。**约束**：路由指令必须由正文显式承担（见 3.2 节的修正）。
- **收敛协议的轮数上限默认值**。supermode 完整模式为 3 轮、轻量模式为 2 轮。本产品评审者数量可配，默认值需在实际运行中校准。
- **多评审者并行调用的可靠性**。要求模型在同一条助手消息里发起多个工具调用，这是提示词层面的约束，需通过实际运行验证其稳定性；若不稳定，退路是由 gate 检测串行调用并提示。
- **配置界面的组件契约版本**。客户端 `settings.section` 的注册方式依赖 dsh 0.1.x 的现状，需在目标版本上验证；必要时降级为纯配置文件驱动，界面作为后续增强。
- **dshmarket 的发布要求**未确认。

### 阶段一遗留、影响后续阶段的技术债

- **挂载协调器缺乏自动化覆盖**。`src/index.ts` 的挂载记账、串行队列、失败路径目前零自动化测试，只由人工推理与一次端到端验收保证。建议在阶段二开工前把「挂载」抽象成可注入的 `(spec) => Promise<() => Promise<void>>`，使并发同步、重复工具名、挂载失败、卸载失败四条路径可测。**阶段三的 `scope.watch()` 重挂载会直接落在这段代码上**，届时再改风险更高。
- **真实 Loader 组合测试尚未建立**（第 9 节列为最关键的一项）。当前替代品是人工端到端验收，不可重放。假 `llm` 服务 + 真 Loader 不需要 API key，建议作为阶段二的第一个任务。
- **`diffMounts` 的 `JSON.stringify` 判等在阶段三才成为活代码**。它依赖两个当前成立、但会被 `applies: 'live'` + `scope.watch()` 打破的前提：键序稳定、`config` 对象引用跨同步稳定。阶段三改动前需补齐 JSDoc 或换成结构化比较。
- **`toolFilter` 表达不了「只读 bash」**。reviewer 与 researcher 目前 deny 了写工具但未限制 `bash`，与 3.2 节的「只读」表述有出入。
- **配错 provider 的用户在 headless 下拿不到原因**：插件的 `logger.warn` 输出在一次性执行模式下不可见（宿主未接控制台 exporter）。阶段三的配置界面是解决它的自然位置。
