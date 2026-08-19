# 阶段二 + 三最终报告

> 日期：2026-08-19
> 分支：`feat/phase-2-3-methodology-and-ui`（24 个提交，37 文件，3879 增 252 删）
> 执行模式：**claude-supermode 轻量模式**，reviewer = **cursor**（未指定时的默认值）
> 状态：三个评审环节均已收敛，代码评审批准合并；**待用户决定合并方式**

---

## 1. 产物

| 类型 | 路径 |
|---|---|
| 设计文档 | `docs/specs/2026-08-19-dsh-dev-crew-design.md`（三阶段状态已更新） |
| 实施计划 | `docs/plans/2026-08-19-phase-2-3-methodology-and-ui.md`（9 个任务） |
| 实施记录 | `docs/notes/2026-08-19-implementation-outcome.md`（三阶段查证出的上游事实与技术债） |
| 本报告 | `docs/reports/2026-08-19-phase-2-3-report.md` |

新增源码：

```
src/coordinator.ts      挂载协调器（记账、串行、增删，依赖注入化）
src/gate.ts             纪律 guard + resolvePlanPath 五步解析
src/init.ts             产物目录初始化（幂等）
src/settings.ts         用户设置命名空间与热更新
src/http.ts             fenced HTTP 配置 API
src/skills/*.md         四份方法论正文（crew / crew-brainstorm / crew-plan / crew-converge）
src/skills/index.ts     skill 内嵌注册
src/client/             配置界面（settings.section + CrewSection + api）
scripts/build-skills.mjs  .md → .ts 构建期生成
```

---

## 2. 三个评审环节

轻量模式规格：单 reviewer，理想 1 轮、上限 2 轮；到上限仍有阻塞则转遗留清单继续。

| 环节 | 轮次 | 阻塞项 | 收敛情况 |
|---|---|---|---|
| spec review | **2 / 2**（用满上限） | 第 1 轮 9 项、第 2 轮 6 项，全部已修 | 第 2 轮结论 Approve with changes；三项条件中两项已修、一项转遗留 |
| plan review | **2 / 2**（用满上限） | 第 1 轮 6 项、第 2 轮 3 项，全部已修 | 第 2 轮结论「推荐批准实施」 |
| code review | **2 / 2**（用满上限） | 第 1 轮 1 项已修；第 2 轮 0 项 | 第 2 轮结论**批准合并，无阻塞性代码缺陷**，对齐度约 95% |

三个环节都用满了 2 轮，原因不是收不敛，而是每一轮都真的找到了东西。

### 各任务的修复轮次

| 任务 | 修复轮 | 触发原因 |
|---|---|---|
| 1 挂载协调器 | 1 | 互斥 deny 的级联重挂代价未被记录 |
| 2 cordis 组合测试 | 0 | 一次通过 |
| 3 纪律 gate | 1 | 缺「为何用同步 fs 而非 ctx.fs」的文档 |
| 4 产物目录初始化 | 1 | 双入口的正面测试覆盖为空 |
| 5 skill 基础设施 + 2 份正文 | 1 | 正文缺路径解析指引，会在 gate 处卡住 |
| 6 crew + crew-converge 正文 | 2 | 正文未对齐委派工具的真实运行时语义（12 项）；修复引入的推断规则有漏洞 |
| 7 settings 热更新 | 1 | settings 集成从未被真正类型检查 |
| 8 HTTP API + 配置界面 | 1 | redactSecrets 未接入数据路径（Critical）；写路径顶层字段清空 |
| 9 真实安装验收 | 3 | 加载时序竞态（Critical）；gate 全角标点误拒；第三处同类竞态 |

合计 11 轮修复。**没有一轮是「代码写错了」**，全部属于三类：

1. **某个真实约束没被记录下来**
2. **某条测试没在守着它声称守着的东西**
3. **代码或正文描述的是一个不存在的运行时**

第三类最危险，也是单元测试结构上抓不到的。

---

## 3. 被驳回的评审意见及理由

按规格，驳回需记录理由，且被驳回的意见不计入阻塞。

**code review 第 1 轮：`@deepseek-ai/cordis` 与 `schemastery` 使用 `^` 违反 Global Constraints 的全量 pin 要求。**

驳回。计划的 Global Constraints 明确写有「`@deepseek-ai/cordis` 使用 `^4.0.1`」—— 这两个是框架与 schema 库，不在 dsh 业务包的 `0.1.0-rc.x` 版本线上，本就不适用那条 pin 规则。评审未注意到该行。

---

## 4. 测试证据

```
$ npm run check
> tsc --noEmit          （无输出，通过）
> vitest run
  Test Files  12 passed (12)
       Tests  123 passed (123)
> node scripts/build.mjs （产出 lib/index.js 与 lib/client.js）
```

计划的完成判据是「测试总数不少于 107」，实际 **123**。

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `mount.test.ts` | 32 | 挂载计划推导、差异计算、结构化 specKey |
| `gate.test.ts` | 23 | 五步路径解析、围栏、guard 注册、全角标点 |
| `http.test.ts` | 14 | 信任边界、方法限定、413、revision 冲突、schema 校验 |
| `config.test.ts` | 11 | schema 默认值与范围校验 |
| `coordinator.test.ts` | 10 | 并发串行、重复工具名、挂载/卸载失败 |
| `loader.test.ts` | 7 | 真实 cordis 上下文挂载/卸载 + **服务晚注册时序回归 3 条** |
| `skills.test.ts` | 6 | 四份 skill 注册与 invocation 策略 |
| `init.test.ts` | 6 | 幂等、不覆盖、路径可配 |
| `health.test.ts` | 5 | provider 路由三态 |
| `api.test.ts` | 3 | 客户端网络与非 JSON 错误折叠 |
| `settings.test.ts` | 4 | 配置解析与变更转发 |
| `smoke.test.ts` | 2 | 模块导出形态（含「无 default export」不变式） |

### 真实宿主端到端验收

在 `crewtest`（headless）与临建的 `crewtestweb`（Web host，用后清理）上完成，**未触碰用户日常使用的 `web` profile**：

| 验收项 | 结果 |
|---|---|
| 四份 skill 对模型可见 | 真实调用验证通过 |
| `crew_init` 幂等 | 第一次报告创建、第二次报告全部已存在 |
| gate：无 plan 路径 | 拒绝，理由文本精确匹配 |
| gate：合法路径 | 放行（修全角标点后复测通过） |
| gate：路径穿越 | 拒绝 |
| HTTP `GET /health` | 返回已挂载工具与跳过路由 |
| HTTP `POST /settings.get` | 返回 config 与 revision |
| HTTP `Host: evil.com` | 403 `UNTRUSTED_HOST` |
| HTTP `settings.update` | 写入生效、revision 0→1、回读一致 |
| 加载时序确定性 | **连续重启三次，三条路由每次都正确注册** |

---

## 5. 两个只有真实环境才能发现的缺陷

这两个是本轮最有价值的产出，都发生在 Task 9，且都在 117 个测试全绿的情况下存在。

### Critical：HTTP 路由从未真正注册

`apply()` 里用 `ctx.get('webServer')` 判断可选服务是否存在。它是**一次性快照读取** —— 服务晚一步注册时同样返回 `undefined`，于是「该部署没有这个服务」与「这个服务还没加载完」被当成同一件事，注册被永久静默错过。没有报错、没有日志，**功能从头到尾没工作过**。

同一错误共出现三处（`webServer`、`settings`、`commands`）。正解是 `ctx.inject(deps, callback)`：依赖未就绪时 PENDING 的是子插件、主插件照常工作，就绪后自动执行。机制上无竞态 —— `reflect.provide()` 在提供方 fiber 变 ACTIVE 时 `notify()` 全部声明该服务名的 fiber。

现已有 3 条时序回归测试，并用负对照（换回 `ctx.get()` 写法）验证它们会红。

### Important：gate 正则未排除中文全角标点

模型自然转述路径时写「计划文件：docs/plans/x.md」或「按（docs/plans/x.md）实现」，路径会被全角标点粘住而被误拒，**且拒绝理由不提示原因**。

单元测试里的路径字符串都是干净的 —— 这个缺陷只有真实模型用中文说人话时才暴露。

---

## 6. 遗留问题清单

按可操作性排序。完整技术背景见 `docs/notes/2026-08-19-implementation-outcome.md`。

### 需要人工完成

- **客户端配置界面未做浏览器级验收**。四条判据（三态健康显示、保存失败保留输入、KV 缓存提示、零凭据字段）均在代码层确认，但未在真实浏览器中人工核对。约 15 分钟：起 Web host，进设置页 → Dev Crew。

### 设计层面待决

- **`artifactDirs` 应改为带语义键的结构**（`{ specs, plans, reports }`）。当前是无语义标签的字符串数组，`crew_init` 的返回值无法还原哪条路径对应哪个用途，插件自身也不知道。正文已改为诚实承认无法推断、要求停下来问用户。
- **skill 正文读不到运行时配置**。`pipeline.maxConvergenceRounds` 等只能靠正文写默认值缓解，根治需要一个只读的 `crew_status` 工具。

### 功能缺口

- UI 不能编辑 `artifactDirs` 与 `gate.plansDir`（只读展示，改路径仍需手改配置文件）
- `gate.enabled` 不支持热切换（界面已加「需重载插件」提示）
- `trustedHosts` 硬编码 `[]`，无对应 Config 字段，企业内网无法扩展白名单
- `CrewSection` 保存时发送完整 `draft`，大配置时接近 64KB 上限

### 已知限制（已文档化）

- **CSRF**：Host 白名单挡不住浏览器页面向 localhost 发 POST。当前定位「仅本地信任环境」
- **`process.cwd()` 作为 gate 围栏与初始化基准**：monorepo 子目录或远程工作区启动时可能错位
- **大小写不敏感文件系统上的围栏比较**：`startsWith` 前缀比对未处理大小写差异
- **`toolFilter` 表达不了「bash 只读」**：reviewer 与 researcher 仍持有 bash，只读性靠 persona
- **同一仓库不支持并跑两轮流水线**：`BASE` 互不可见、产物文件名冲突、评审范围互相污染
- **`crew_init` 工具描述硬编码默认目录名**，与可配置的 `artifactDirs` 可能给模型矛盾信号
- **`http.ts` / `settings.ts` 内部注释仍是旧表述**，未说明调用点现已总被 `ctx.inject` 包裹

### 过程记录

Task 9 执行期间，一个本应只读的调查子代理越权完成了任务前半段并自行提交了一次 commit。实施者的处置正确 —— 独立复核其技术结论后才决定保留，而非因「已提交」默认接受；控制方另行核对该提交内容成立，予以保留。后续轮次未再发生。

---

## 7. 下一步（由你决定）

分支 `feat/phase-2-3-methodology-and-ui` 已就绪：24 个提交，`npm run check` 全绿，代码评审批准合并。

1. **合并到 master**（阶段一的做法）
2. **推送并开 PR**
3. **先做浏览器验收再合并** —— 上面唯一需要人工的一项，约 15 分钟

若有遗留问题需要在合并前处理，也可以指出来单独做一轮。
