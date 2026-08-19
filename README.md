# dsh-dev-crew

一个 DeepSeek Harness 插件：按职责把工作分派给绑定了不同模型的子代理。

需求整理与评审交给强模型，批量实现交给低成本模型，全部在同一个会话内完成。

## 安装

发布前（尚未上架 npm），请用本地路径安装：

```sh
dsh plugin --profile <你的 profile> add <本仓库绝对路径>
```

发布后可改为按包名安装：

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
            provider: kimi-coding
            model: k3
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
工具；插件会通过 `ctx.logger` 记录一行说明原因的警告，但该警告在当前 headless
一次性执行模式下不会打印到终端（见「已知限制」）。

内置三个角色 `implementer` / `reviewer` / `researcher`，各自带有写好的 persona
与工具范围，默认全部停用 —— 因为路由取决于你自己配置了哪些 provider。

用这三个 id 时只需写 `id` + `models` + `enabled`：未提供的 `persona` 与
`toolFilter` 由插件按 id 用内置模板填充。显式写出则以你的值为准，且是整体替换
而非与内置值合并 —— 自己写 `toolFilter` 就要把想保留的 `deny` 项一并列出。非内
置 id 不做填充。

无论是否填充，每个角色的子代理都看不到本插件挂出的其他委派工具：插件会把本次实
际挂上的其他 `subagent_*` 工具名追加进该角色的 `deny`，避免子代理沿角色链继续
向下分派。

两个角色用同一个 `id`（或同一角色内两个模型用同一个 `alias`）会推出重名工具，插
件在挂载前直接报错，不会挂上一个卸不掉的实例。

配置支持热更新：宿主组合了 `settings` 服务时，本插件会在 `dsh-dev-crew`
命名空间下注册用户设置文档，`roles` 等字段的变更会即时同步到已挂载的工具集，
无需重新加载插件。未组合 `settings` 服务的部署（例如 headless）不受影响，继续
使用 profile 里的入口配置。

`gate.enabled` 是例外：它只在插件挂载时决定是否注册纪律 guard，中途通过设置
页开关不会生效，需要重新加载插件才能应用。`gate.plansDir` 不受此限制，热更新
后立即生效。

## 内嵌方法论 skill

插件随包分发四份 skill，正文在构建时内嵌（`npm run build:skills`），不依赖用户侧
的项目/用户 skill 目录：

| skill | 用途 | 触发方式 |
|---|---|---|
| `crew` | 端到端开发流水线：需求讨论 → 预检门 → 写规格/计划 → 逐任务实现 → 三轮评审收敛 → 落盘报告。规格讨论是流水线里唯一的人工环节。 | 对人：说"走 crew 流程" / 提到开发流水线；对模型：调用 `skill` 工具，`name` 传 `crew` |
| `crew-brainstorm` | 把一个模糊需求讨论成可实施的规格文档 | 单独使用：需求不清楚、想先讨论出规格；也是 `crew` 流水线第 1 步内部调用的对象 |
| `crew-plan` | 把一份规格文档拆成可逐任务执行的实施计划 | 单独使用：已有规格、要拆成可分派的任务；也是 `crew` 流水线第 4 步内部调用的对象 |
| `crew-converge` | 评审收敛协议：并行起多个 reviewer、分类阻塞/非阻塞项、修复复审、到轮次上限转遗留清单 | **只对模型可见**（`invocation: { modelInvocable: true, userInvocable: false }`），人不能单独触发 —— 它是 `crew` 内部在三处评审环节（规格/计划/代码）调用的机制，独立唤起没有意义 |

`crew-converge` 的 `userInvocable: false` 只影响 Web host 的命令面板（该过滤逻辑
`isUserInvocable` 仅被 `@deepseek-ai/dsh-host-apiproxy` 消费，用来给客户端命令面
板供数据）；headless 部署没有交互式命令面，这条隔离在源码/组装层面即可确认，无需
也无法在 headless 下用一次真实的 `/` 命令列表点验。

## `crew_init` 与 `/crew-init`

创建流程产物目录（默认 `docs/specs`、`docs/plans`、`docs/reports`，实际以
`artifactDirs` 配置为准）。两个入口调用同一段逻辑：

- 工具 `crew_init`：模型可调用，无参数，返回 `{ created, skipped }`。
- 命令 `/crew-init`：注册在可选的 `commands` 服务下（`ctx.get('commands')`），供
  人在支持命令面的宿主（Web host）里直接触发；headless 部署即使组合了
  `@deepseek-ai/dsh-commands` 服务，也没有交互式命令输入面去敲这个命令。

**幂等**：已存在的目录原样跳过、不覆盖任何已有文件；目录解析基准是
`process.cwd()`（见「已知限制」）。

## 纪律 gate：调用 implementer 前必须给出 plan 路径

`gate.enabled`（默认 `true`）开启时，`ctx.tools.guard()` 拦截所有
`subagent_implementer` / `subagent_implementer_<alias>` 工具调用：prompt 里必须能
解析出一个**真实存在、类型为普通文件、且落在 `gate.plansDir`（默认 `docs/plans`）
之内**的路径，五步判据（候选提取 → resolve 规范化 → 围栏前缀检查 → 存在性/文件
类型 → realpath 二次围栏检查，防符号链接逃逸）见 `src/gate.ts`。不满足则拒绝，
拒绝理由会原样回给模型，指导它先把计划文件写出来。

**关闭方式**：把 `gate.enabled` 设为 `false`。注意这个开关只在插件挂载时读取一次
（见「已知限制」），中途通过设置页或 `settings.update` 改它不会立即生效，需要重
新加载插件。`gate.plansDir` 没有这个限制，热更新后立即生效。

## HTTP API 与配置界面

宿主组合了 `@deepseek-ai/dsh-host-webserver`（即 `ctx.get('webServer')` 非空，通常
是 Web host，headless 部署没有这一层）时，插件在 `/crew/api` 前缀下注册三条路由：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/crew/api/health` | GET | 返回 `{ mounted, skipped }`：已挂载的委派工具名与被跳过的路由及原因，补上 headless 下 `logger.warn` 不可见的可观测性缺口 |
| `/crew/api/settings.get` | POST | 返回 `{ config, revision }`：脱敏后的当前配置与 revision |
| `/crew/api/settings.update` | POST | body 为 `{ config, expectedRevision }`，走 `settings.update()` 的 merge-then-validate；revision 冲突返回 409 `REVISION_CONFLICT` |

三条路由都要求 Host 头精确匹配回环地址（`localhost` / `127.0.0.1` / `[::1]` /
`::1`）或部署显式配置的 `trustedHosts`（当前插件把它硬编码为空数组，尚无 schema
与界面绑定），不匹配一律 403 `UNTRUSTED_HOST`。**这只是主机名白名单，不是 CSRF
防护**：Host 头检查挡不住浏览器页面向 `localhost` 发起的跨站 POST，当前定位是
「仅面向本地信任环境」，请勿在暴露给不受信任网络的部署上依赖它。

配套的客户端配置界面（`src/client/CrewSection.tsx`，通过 `dsh.client.inject` 挂进
`settings.section`）走同一套 HTTP API 读写配置、展示角色列表与健康状态。

**这两条能力都需要 Web host**：本次在 headless 的 `crewtest` profile 下验证时，
`--dump-config` 未见任何 `webServer`/`host-webserver` 插件 id，`ctx.get('webServer')`
为 `undefined`，`registerCrewApi` 按设计返回空 disposer，三条路由与配置界面均不
存在。若要实测这部分，需要一个组合了 Web host 的 profile；不要为此改动或复用用户
日常使用的 `web` profile。

## 已知限制

- 角色的启停会改变工具集，使全部会话的模型缓存前缀失效，下一轮请求需重新预填充。
- 子代理后端固定为 `spawn`（干净上下文）。不提供 fork：fork 的前缀复用收益会被
  continuable 子代理装入请求头部的内容抵消。
- 路由不可用时对应的 `subagent_<role>` 工具不会挂载，插件会调用
  `ctx.logger().warn()` 记录原因，但在 `dsh --profile <name> "<task>"` 这类
  headless 一次性执行模式下，该日志当前不会打印到终端（宿主未接控制台输出
  exporter，消息只留在 cordis 的内存日志缓冲区）。判断路由是否生效，请以对应
  `subagent_<role>` 工具是否出现在工具列表中为准，而非等待一行警告文本。
- **`gate.enabled` 是启动期开关**：只在插件挂载时决定是否注册纪律 guard，中途
  通过设置页或 HTTP API 改它不会生效，需要重新加载插件才能应用。`gate.plansDir`
  不受此限制。
- **纪律 gate 的路径候选提取对紧邻的全角标点不健壮**（已在真实客户端联调中复现，
  见 `src/gate.ts` 的 `CANDIDATE` 正则）：候选字符类只排除 ASCII 的反引号/引号/
  圆括号与空白，不排除中文全角标点（如 `：`、`（`、`）`）。协调者模型用自然中文
  转述任务时，若路径前紧跟全角冒号（例如"计划文件：docs/plans/x.md"）或路径后紧
  跟全角括号（例如"docs/plans/x.md（相对当前工作区根目录）"），这段标点会被贪婪
  地并入候选串，导致 `resolve()` 出的路径带有多余前后缀而无法通过围栏检查 ——
  一个真实存在、合法落在 `plansDir` 内的路径会被**误拒**。现有单测（`tests/gate.
  test.ts`）用 `` `按 ${planFile} 实现` `` 这类路径两侧留有 ASCII 空格的写法，
  没有覆盖这种紧邻全角标点的场景，因此 100% 覆盖率下未被发现。**当前可行的规避
  方式是让 prompt 用反引号包住路径**（``` `docs/plans/x.md` ```）——反引号是正则
  显式识别的包裹符，能正确界定候选边界；正式修复需要扩充候选字符类排除范围或改用
  显式包裹符优先匹配，留待后续任务处理。
- **`process.cwd()` 作为 gate 围栏与 `crew_init` 的解析基准**。在 monorepo 子目录
  或远程工作区启动时，cwd 可能不是用户认为的项目根，请在仓库根启动 `dsh`。
- **大小写不敏感文件系统上的围栏比较**。`startsWith` 前缀比较在 macOS/Windows 上，
  `realpathSync` 返回的大小写可能与配置值不一致。当前未处理。
- **`trustedHosts` 有字段但无 schema 与界面绑定**，企业内网部署暂时只能走默认的
  loopback 白名单。
- **HTTP API 与配置界面依赖 Web host**：`ctx.get('webServer')` 未组合时（例如
  headless 部署）两者都不存在，`registerCrewApi` 返回空 disposer，不会报错也不会
  留任何提示。
- `toolFilter` 表达不了「只读 bash」，reviewer 与 researcher 的只读性仍靠 persona。
- 同仓库并发跑两轮流水线未支持。

## 许可

MIT
