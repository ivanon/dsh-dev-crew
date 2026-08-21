# dsh-dev-crew

一个 DeepSeek Harness 插件：按职责把工作分派给绑定了不同模型的子代理。

需求整理与评审交给强模型，批量实现交给低成本模型，全部在同一个会话内完成。

## 安装

需要 dsh **0.1.0-rc.7 或更新**。本插件对 dsh 自带（in-box）的包一律不作依赖声明 —— 它们由 `~/.dsh/profiles/node_modules` 提供，声明反而会装出第二份实例（见 [notes §2.6](docs/notes/2026-08-19-implementation-outcome.md)）。代价是这条版本下界只能写在文档里：装在更旧的宿主上会在挂载子代理工具时失败，而不是在安装时被拒。

发布前（尚未上架 npm），请用本地路径安装：

```sh
dsh plugin --profile <你的 profile> add <本仓库绝对路径>
```

发布后可改为按包名安装：

```sh
dsh plugin --profile <你的 profile> add dsh-dev-crew
```

## 配置

组合了 web app 的部署可以**全程在界面里配置**，不必写 YAML：设置页的 Dev Crew
区块列出三个内置角色，每个可勾选启用、从下拉菜单选 provider、从模型目录选或手填
model，另有收敛轮数上限与纪律 gate 开关。provider 下拉的选项来自宿主的活路由与
已声明未激活路由；选「自定义…」可填一个宿主尚不认识的路由名（先填后配）。model
用可输入的建议列表而非固定下拉：模型目录是建议性的，不在目录里的 id 仍然合法，
未激活的 provider 也拉不到目录。

界面配不出来的三样，仍需 YAML：**同一角色的第二个模型**（多模型角色，见下文工具
命名规则）、**非内置 id 的新角色**、**`persona` 与 `toolFilter`**。

下面是 YAML 形式。在 profile 的 `cordis.patch.yml` 中配置角色，每个角色可绑定一个
或多个模型，每个模型对应一个独立的委派工具。

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

### 子代理结果如何回到编排者

这一点决定整条流水线能不能跑通。委派工具立刻返回的是**子代理 id，不是结果**。结果
有两条通道，**主通道是运行时自动送达的结算通知**：

```
Background subagent <id> finished and will do no further work unless you send it more.
Its closing message:
<子代理最后一条消息的全文>
```

开场白按结束方式分几种，**只有 `finished` 表示做完了**（其余是 `was stopped
before it finished`、`ran out of room before it finished`、`declined the task`、
`failed before it finished`，以及无输出时的 `It left no closing message.`）。编排者
从这一行判断成败，不看内容像不像完整的。

**只有子代理的最后一条消息会被带回**（`ActivationTerminal.output` 的定义是 "the
epoch's final assistant content"），中间轮次的内容留在它自己的 transcript 里，编排者
看不到。因此内置 persona 都要求那条消息承载该带回的内容、不要以「完成了」这类空话结
尾——implementer 与 researcher 放完整结论，reviewer 放**摘要**（全文写进它自己落盘的
评审文件，见下）。`tests/config.test.ts` 有回归测试保护这几条。

第二条通道是 `report` 工具：子代理可在**任何时刻**主动送内容（前缀
`Background subagent <id> reported:`），不受「只有最后一条」限制。它适合中途报告，
或结论较长时确保送达；但**收到 `reported:` 不代表子代理做完了**——做完的判据只有结算
通知。

两种消息都会**开启编排者的新一轮**（结算通知走 `followup()` 唤醒 idle 的父代理，父
代理正忙时并入下一个 step 批次；`report` 的 `reportDelivery` 默认 `wakeup`）。因此
编排者派完子代理就该**结束当轮**，不能在同一轮里轮询——通知不可能在那一轮内到达，只
会撞上宿主的重复调用告警。`job_output` / `job_list` / `job_kill` 管的是 **shell 后台作业**
（例如编排者自己用 `&` 起的开发服务器），与子代理是两套东西：拿子代理 id 调它们必然失
败，但用它们查自己起的进程是正常用法。

`crew-converge` 的 `userInvocable: false` 只影响 Web host 的命令面板（该过滤逻辑
`isUserInvocable` 仅被 `@deepseek-ai/dsh-host-apiproxy` 消费，用来给客户端命令面
板供数据）；headless 部署没有交互式命令面，这条隔离在源码/组装层面即可确认，无需
也无法在 headless 下用一次真实的 `/` 命令列表点验。

## `crew_init` 与 `/crew-init`

创建流程产物目录（默认 `docs/specs`、`docs/plans`、`docs/reviews`、`docs/reports`，
实际以 `artifactDirs` 配置为准）。两个入口调用同一段逻辑：

- 工具 `crew_init`：模型可调用，无参数，返回 `{ created, skipped }`。
- 命令 `/crew-init`：注册在可选的 `commands` 服务下，走
  `ctx.inject(['commands'], cctx => {...})`（而不是一次性的 `ctx.get('commands')`
  快照，理由见「HTTP API 与配置界面」一节对同一模式的说明），供人在支持命令面的
  宿主（Web host）里直接触发；headless 部署即使组合了 `@deepseek-ai/dsh-commands`
  服务，也没有交互式命令输入面去敲这个命令。

**幂等**：已存在的目录原样跳过、不覆盖任何已有文件；目录解析基准是
`process.cwd()`（见「已知限制」）。

### 产物命名与轮次

规格、计划、评审意见三类产物的文件名都带评审轮次后缀 `_r<N>`：

| 目录 | 文件名 | 产出者 |
|---|---|---|
| `docs/specs` | `YYYY-MM-DD-<topic>_r1.md` | 编排者（`crew-brainstorm`） |
| `docs/plans` | `YYYY-MM-DD-<topic>_r1.md` | 编排者（`crew-plan`） |
| `docs/reviews` | `YYYY-MM-DD-<topic>-<spec\|plan\|code>_r<N>-<reviewer 工具名>.md` | **reviewer 自己**（每环节每轮每 reviewer 一份） |
| `docs/reports` | `YYYY-MM-DD-<topic>-report.md` | 编排者（第 8 步，只一份） |

**每一轮修复另存新版本，不原地改**：第 N 轮评审的对象是 `_rN`，修复后写成
`_r<N+1>`，旧版本原样保留。这样每轮的输入输出都可追溯，复审者能对比两版差异，最终
报告也能指明结论是第几轮达成的。代码不适用这条——代码的版本由 git 提交承担。

**另存的做法是 `cp` 再逐处 `edit`，不是 `write` 整份文件。** `write` 的输出量等于文件
全长，一份几百行的计划就是几万 token；模型有单次响应输出上限（`kimi-for-coding` 只有
32,768），超出会让那一轮以 `max-tokens` **静默结束**——不提示、不自动继续，编排者就停
在那里，看起来像卡死。真实会话里发生过：编排者修计划时一次输出撞到 32,768，流水线在
第二轮评审后无声停止。skill 正文因此要求先 `cp` 出新版本（零输出），再一处一个阻塞项
地 `edit`；implementer 的 persona 同样要求改已有文件用 `edit` 而非重写。

分派实施时给 implementer 的计划路径必须是**收敛后的最终版本**。纪律 gate 只校验路径
落在 plans 目录内，不会发现你传的是哪一版。

**评审意见由 reviewer 自己落盘。** 编排者在 prompt 里给出它该写的文件的完整路径（一个
reviewer 一份，路径撞车会让后写的覆盖先写的），reviewer 用 `write` 写全文，并把**摘要**
放在它最后一条消息里：文件路径、几条阻塞项、每条一句话。编排者据摘要判断收敛，需要细
节时才读文件——这样意见全文既不受「只有最后一条消息会被带回」的限制，也不占编排者上
下文。

分类之后，编排者在每份文件末尾追加自己的判断：哪些判为阻塞、**驳回的意见及理由**（这
一节只能由它写，reviewer 不知道自己被驳回了）、本轮是否收敛。

reviewer 因此需要写权限，`toolFilter.deny` 里没有 `write`。**这道纪律没有工具级强制**：
`write` 的语义是 create or fully replace，能覆盖任何文件，而 `bash` 本来也在范围内。
「只写给定的那个文件、绝不碰评审对象」完全靠 persona 约定，加上 `crew-converge` 要求编
排者核对文件确实被创建。`edit` 仍被拒——局部修改已有文件与写一份新报告无关。

reviewer 若始终不落盘，编排者退回用摘要自己转录一份，并在文件里注明是转录——一份没写
下来的评审等于没评审，但也不值得为落盘失败中止整条流水线。

### 每一轮评审都要落盘

首轮由编排者在 prompt 里给出文件路径；**复审同样要给一个新路径** `..._r<N+1>-<reviewer
工具名>.md`，每轮各自成文。不要让 reviewer 追加或覆盖上一轮那份——那是上一轮的证据。

真实会话里规格评审到了 r3、计划评审到了 r4，而 reviews 目录只有 `_r1` 的文件：第 2 轮
之后的评审结论只存在于会话上下文里，会话一关就没了，最终报告也无从引用。

### 产物日期取自 `date +%F`

模型对「今天」的印象来自训练数据，通常落在过去某一年——真实会话里 13 个产物文件全部
写成了 `2025-08-20`，实际是 2026 年。日期错了不会有任何报错。规格落盘时取一次，后续
计划、评审、报告共用同一个日期。

### 写报告之前的三条检查

`crew.md` 第 8 步要求先跑三条再动笔：`git status --porcelain` 必须为空（不为空要查清是
漏提交还是构建产物被误纳入版本控制，后者本身是一条该记入报告的问题）、
`git log <BASE>..HEAD` 确认交付物真在提交里、数一遍 reviews 目录每轮是否都有文件。报告
的必填项里每一项都要出现，没有内容的写「无」——真实会话里一份 196 行的报告只写了一行
「评审轮次」，遗留清单、驳回意见、reviews 路径、预检门结果、测试证据全部缺失。

### 谁修阻塞项

规格与计划的阻塞项由编排者自己改（`cp` 出新版本再逐处 `edit`）；**代码的阻塞项一律
派 `subagent_implementer`，不论多小**。编排者直接改的代码没有经过任何评审，而且读文件
跑测试会挤占它跑完剩余步骤所需的上下文。

派发时 prompt 必须给**两个**路径：**计划文件**（纪律 gate 校验的是它——评审文件在
reviews 目录、不在 plans 目录内，只给评审文件过不了 gate）和**评审文件加上要修的条目
编号**（告诉 implementer 改什么）。

skill 正文另外明确禁止用 `todo_write` 记录阻塞项：那是编排者自己的待办清单，把「修复
B1」写进去等于向自己声明这件事由自己做。真实会话里编排者刚说完「派出实现子代理」，用
`todo_write` 列了 10 条「修复 Bx」，下一句就改成「让我开始修复」，然后一路自己改完。要
跟踪就把条目写成「派 implementer 修 B1」。

**这条纪律没有工具层强制，只有文本约束。** 能想到的强制手段（禁止根 agent 写 `docs/`
之外的文件）会误伤把本插件装在常规会话里、直接让主 agent 改代码的正常用法，所以没有
采用。

### 与 goal 循环的关系

宿主的 goal 机制（`create_goal` / `get_goal` / `update_goal`）会在目标未完成时**每轮
自动唤醒 agent**，投递一条 `<goal_round>` 消息。这与本流水线的等待语义直接冲突：编排
者派出子代理后正确地结束了本轮，goal 立刻把它叫醒，它只能查一次状态、发现还在跑、再
写一次交班记录——真实会话里这样连转了 12 轮，每轮都是干净的 `completed`，一步没进。

skill 正文因此要求：收到过 `<goal_round>` 就说明有活跃 goal，**派出子代理后先
`update_goal(goal_id, revision, action: "pause")` 再写交班记录**，回报到达后 `resume`。
子代理的结算通知是独立机制，不受 goal 暂停影响。

正文另有一条：**不要为这条流水线创建 goal**。宿主允许模型推断「长期任务意图」并自动
`create_goal`，而流水线本身就是事件驱动的，叠加 goal 只会在等待期间反复空转。

## 循环卫生 guard：拦截 `list_agents` 轮询

`loopGuard.enabled`（默认 `true`）开启时，`ctx.tools.guard()` 跟踪每个 agent 最近一个
工具的**连续**调用次数，拦两种病态调用。任何其他工具调用都会把计数清零，所以「查一次
再做别的事」不受影响；计数按发起调用的 Agent 分别累计（`WeakMap` 键为 Agent 对象，随
其回收释放），子代理的行为不会拖累编排者。

**一、`list_agents` 轮询** —— 连续调用超过 `loopGuard.maxConsecutiveAgentListings`
（默认 3）即拒绝。

**二、空选项的提问** —— `ask_user_question` 里任何一个问题带着 `options: []` 即拒绝。
那语义上是「这里有一份选项列表」然后一个都不给，而它几乎只出现在一种场合：编排者想
执行「等待」，而这个工具会阻塞等用户输入，是它能找到的最像等待的动作。真实会话里编
排者派出 reviewer 后先跑了 `bash echo "waiting"`（description 自陈 "Placeholder while
waiting for reviewer"），紧接着发出
`{id:"placeholder", header:"Wait", question:"This is a placeholder", options:[]}`——流水线
就卡死在一个用户无法回答的选择框上。省略 `options` 的自由输入题不受影响。

**三、重复派发同一 reviewer** —— 同一个 `subagent_reviewer*` 工具连续派发第二次即
拒绝。真实会话里编排者用两段不同 prompt 把同一个工具派了两次、自称「第二视角」，还把
两份评审文件分别命名为 `..._r1-subagent_reviewer.md` 与 `..._r1-subagent_reviewer_2.md`
——两次跑的是同一个 provider 与 model，不构成独立视角，只是让这一环节成本翻倍。视角
数量由部署方决定：给 reviewer 角色配几个模型就挂出几个工具，同一环节各派一次是正确用
法（工具名不同，各自计数）。复审不走新派发，走 `send_message`。

**为什么需要它**：编排者想「执行等待」，而唯一看起来像等待的工具就是 `list_agents`。
真实会话里它一次连调 149 次、单次会话累计 1069 次，直到模型额度耗尽（403 usage
limit）才停——期间子代理的回报消息已经到达，循环却没被打断。宿主自带的重复调用告警
（"You are repeating the exact same tool call"）只是提示，实测无法阻止。skill 正文
写了「不要轮询」同样无效，所以这条约束必须在工具层强制。

拒绝理由讲清了等待的正确做法：**结束本次响应、不调用任何工具**，运行时会在通知到达
时开启新一轮。

## 纪律 gate：调用 implementer 前必须给出 plan 路径

`gate.enabled`（默认 `true`）开启时，`ctx.tools.guard()` 拦截所有
`subagent_implementer` / `subagent_implementer_<alias>` 工具调用：prompt 里必须能
解析出一个**真实存在、类型为普通文件、且落在 `gate.plansDir`（默认 `docs/plans`）
之内**的路径，五步判据（候选提取 → resolve 规范化 → 围栏前缀检查 → 存在性/文件
类型 → realpath 二次围栏检查，防符号链接逃逸）见 `src/gate.ts`。不满足则拒绝，
拒绝理由会原样回给模型，指导它先把计划文件写出来。

**围栏基准是发起调用的会话自己的工作目录**（`execution.agent.session.header.cwd`，
宿主在会话创建时校验为绝对路径），不是 dsh 进程的启动目录 —— 所以 `dsh web` 一个
长驻进程可以服务多个项目，无需为每个项目重开。会话未携带 cwd 时才回退到
`process.cwd()`。拒绝理由里会写出解析出的围栏绝对路径与它的基准来源，配置错位
因此可诊断，而不是让模型反复重试一个正确的路径。

候选路径提取会跳过 ASCII 的反引号/单双引号/圆括号/空白，**也跳过中文全角标点**
（弯引号 `“”‘’`、CJK 符号与标点如 `：（）。、「」『』【】〔〕《》`、以及其他全角/
半角字符），所以协调者模型用自然中文转述任务时，即使路径紧邻这些标点书写（例如
"计划文件：docs/plans/x.md"、"docs/plans/x.md（相对当前工作区根目录）"）也能被
正确识别；`tests/gate.test.ts` 有对应用例覆盖，包括确认排除全角标点不会连带放宽
路径穿越/符号链接逃逸的围栏检查。

**关闭方式**：把 `gate.enabled` 设为 `false`。注意这个开关只在插件挂载时读取一次
（见「已知限制」），中途通过设置页或 `settings.update` 改它不会立即生效，需要重
新加载插件。`gate.plansDir` 没有这个限制，热更新后立即生效。

## HTTP API 与配置界面

宿主组合了 `@deepseek-ai/dsh-host-webserver`（即 `ctx.get('webServer')` 非空，通常
是 Web host，headless 部署没有这一层）时，插件在 `/crew/api` 前缀下注册五条路由。
只读查询用 GET，配置读写用 POST：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/crew/api/health` | GET | 返回 `{ mounted, skipped }`：已挂载的委派工具名与被跳过的路由及原因，补上 headless 下 `logger.warn` 不可见的可观测性缺口 |
| `/crew/api/providers` | GET | 返回 `{ live, configurable }`：宿主的活路由与已声明未激活路由，供界面渲染 provider 下拉 |
| `/crew/api/models?provider=<name>` | GET | 返回 `{ models }`：该 provider 广告的模型 id。未注册的路由在宿主侧会抛错，这里折叠成空数组——模型目录是建议性的，空目录不代表 provider 不可用。缺 `provider` 参数答 400 `MISSING_PROVIDER` |
| `/crew/api/settings.get` | POST | 返回 `{ config, revision }`：脱敏后的当前配置与 revision |
| `/crew/api/settings.update` | POST | body 为 `{ config, expectedRevision }`，走 `settings.update()` 的 merge-then-validate；revision 冲突返回 409 `REVISION_CONFLICT` |

三条路由都要求 Host 头精确匹配回环地址（`localhost` / `127.0.0.1` / `[::1]` /
`::1`）或部署显式配置的 `trustedHosts`（当前插件把它硬编码为空数组，尚无 schema
与界面绑定），不匹配一律 403 `UNTRUSTED_HOST`。**这只是主机名白名单，不是 CSRF
防护**：Host 头检查挡不住浏览器页面向 `localhost` 发起的跨站 POST，当前定位是
「仅面向本地信任环境」，请勿在暴露给不受信任网络的部署上依赖它。

配套的客户端配置界面（`src/client/CrewSection.tsx`，通过 `dsh.client.inject` 挂进
`settings.section`）走同一套 HTTP API 读写配置、展示角色列表与健康状态。

**这两条能力都需要 Web host**：在 headless 部署下（例如本仓库用于验收的
`crewtest` profile），组合树里没有 `webServer` 服务，三条路由与配置界面都不存在
——这是 headless 部署形态本身的限制，不是 bug。

在组合了 Web host 的部署下，路由注册走的是 `ctx.inject(['webServer'], hctx => {
hctx.effect(() => registerCrewApi(hctx, {...})) })`（`registerCrewSettings` 对
`settings` 服务同理）：`ctx.inject` 会新建一个只在 `webServer` 服务就绪后才执行
的子插件，服务缺失或还没轮到时子插件停在 `PENDING`、主插件不受影响，服务就绪后
自动执行——不依赖 `webServer`/`settings` 是否已经在 `apply()` 执行的那一刻存在。
`webServer`/`settings` 都**没有**写进主插件顶层的 `inject` 数组，因为那样会让
整个插件在 headless（不组合这两个服务）下永久 `PENDING`。

已在新建的 `crewtestweb` profile（`['@deepseek-ai/dsh-base',
'@deepseek-ai/dsh-web-app', 'dsh-dev-crew']`）上端到端实测通过，包括
`settings.update` 的写入 + revision 递增 + 回读一致：

```
$ curl -s localhost:3099/crew/api/health
{"ok":true,"value":{"mounted":["subagent_implementer"],"skipped":[]}}
$ curl -s -X POST localhost:3099/crew/api/settings.get
{"ok":true,"value":{"config":{...},"revision":0}}
$ curl -s -H 'Host: evil.com' localhost:3099/crew/api/health
{"ok":false,"error":{"code":"UNTRUSTED_HOST","message":"request rejected by the plugin trust fence"}}
```
（第三条正确返回 403。）连续重启该 profile 三次复测，三条路由每次都正确注册，
排除了偶发时序窗口的可能。

客户端配置界面（`CrewSection.tsx`）的实际浏览器渲染（三态健康显示、保存失败时
表单不丢内容等）未做人工可视化验证，只验证了它依赖的 HTTP API 契约；见「已知
限制」。

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
- **`crew_init` 的解析基准仍是 `process.cwd()`**。gate 围栏已改为会话自己的工作
  目录（`SessionHeader.cwd`），但 `crew_init` 尚未跟进，所以在 `dsh web` 这类长驻
  进程里它仍按**进程启动目录**建目录，可能不是当前会话所在的项目。手动跑
  `/crew-init` 前请确认启动目录，或直接让流水线的预检门去建（同样受此限制）。
- **大小写不敏感文件系统上的围栏比较**。`startsWith` 前缀比较在 macOS/Windows 上，
  `realpathSync` 返回的大小写可能与配置值不一致。当前未处理。
- **`trustedHosts` 有字段但无 schema 与界面绑定**，企业内网部署暂时只能走默认的
  loopback 白名单。
- **HTTP API 与配置界面依赖 Web host**：`webServer` 服务未组合时（例如 headless
  部署）两者都不存在，路由注册子插件（`ctx.inject(['webServer'], ...)`）永久停在
  `PENDING`，主插件不受影响，但不会有任何报错或提示——判断这两条能力是否可用，
  请以 `GET /crew/api/health` 是否有响应为准。
- **客户端配置界面只做过部分浏览器级验证**：五条路由的请求/响应、403 拒绝、
  revision 冲突都有自动化覆盖，健康态显示与保存落盘已在真实浏览器里确认（那次
  确认本身发现了保存后健康态不刷新的缺陷，见 issue #1）。仍未在浏览器里走过的：
  保存失败时表单是否保留输入、KV 缓存失效提示、provider 下拉与 model 建议列表的
  实际渲染。这一层没有自动化验收。
- **界面的表达力窄于 YAML**：能启停角色、选 provider、选或填 model、改收敛轮数与
  gate 开关，但配不出同一角色的第二个模型、非内置 id 的新角色、以及 `persona` 与
  `toolFilter`。后两者界面从不提交，所以用户层留空、最终值落回组合层配置或按角色
  id 填充的内置模板。
- **`toolFilter` 表达不了路径级权限，也表达不了「只读 bash」**。reviewer 需要 `write`
  才能落盘自己的评审文件，而 `write` 的语义是 create or fully replace——它能覆盖任何
  文件，包括正在评审的产物；`bash` 也一直在范围内。「只写给定的那个评审文件」完全靠
  persona 约定与编排者的事后核对，没有任何强制。researcher 不需要落盘，仍拒 `write`。
- **`toolFilter` 里的工具名是对宿主的外部引用，没有任何机器校验**。宿主的
  `tools.restrict()` 对未知名字**抛错而非忽略**，所以一个拼错或不存在的名字会让
  整个角色在委派时失败。内置模板的名字有回归测试兜底（`tests/config.test.ts`），
  但用户在 YAML 里自己写的没有——改动前请用真实宿主确认名字存在。
- 同仓库并发跑两轮流水线未支持。

## 许可

MIT
