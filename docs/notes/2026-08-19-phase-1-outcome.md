# 阶段一收尾：已交付什么，以及后续阶段开工前必须知道的事

> 日期：2026-08-19
> 分支：`feat/phase-1-skeleton-and-roles`（17 个 commit，19 个文件，41 个测试）
> 状态：整分支评审通过，可交付

本文记录阶段一实施过程中查证出来的、**代码本身读不出来的事实**，以及它们对后续阶段的约束。设计文档记录「打算做什么」，本文记录「做的过程中发现真实世界是什么样」。

---

## 一、交付内容

按角色挂载子代理委派工具的完整链路：

| 模块 | 职责 |
|---|---|
| `src/types.ts` | 角色、模型、工具范围的类型 |
| `src/config.ts` | schemastery schema + 三个内置角色（implementer / reviewer / researcher） |
| `src/health.ts` | provider 路由三态判定（就绪 / 未配置 / 不存在），纯函数 |
| `src/mount.ts` | 挂载计划推导与差异计算，纯函数 |
| `src/index.ts` | 插件入口：可重入的挂载同步，跟随 `llm/adapters-updated` |

端到端验收已在真实 dsh（`0.1.0-rc.7`）上通过：主代理跑 `deepseek-official`，子代理跑 `kimi-coding/k3`，两者确为不同 provider。

---

## 二、上游事实（查证所得，非推测）

### 2.1 dsh 库包的 npm dist-tag 是坏的

`@deepseek-ai/dsh-*` 库包的 `dist-tags.latest` 指向陈旧的 `0.0.1-rc.1`，而实际版本线是 `0.1.0-rc.x`。按常规写法 `npm install @deepseek-ai/dsh-tools` 会装到错误版本。

**必须 pin 精确版本**，且**整条线版本必须统一**：`0.1.0-rc.6` 的库包互相声明 `^0.1.0-rc.6` 的 peer 依赖，npm 解析该范围会取 `rc.7`，而 `rc.7` 又要求其 peer 同为 `rc.7` —— 混用产生无法解析的 ERESOLVE 冲突。

CLI 包 `@deepseek-ai/dsh` 的 dist-tag 正常，不受此限。

### 2.2 委派工具的 description 不可定制，所有角色工具描述逐字节相同

`dsh-tool-subagent` 的 `description` 只由 provider 种类（spawn / fork）与 `backgroundMode` 决定，**不含 `persona`，不含 `toolName`，Config 里也没有 description 字段可覆盖**。

因此 `subagent_implementer`、`subagent_reviewer_ds`、`subagent_researcher`、以及 base 自带的 `subagent`，在模型看到的工具清单里描述完全一致，只有名字不同。

**这推翻了设计文档 3.2 节「固定角色比任意 alias 更有语义区分度」的论证依据。** 设计本身不必回滚（工具名仍有一定自描述性），但结论变了：

> **路由指令必须由 skill 正文承担，不能指望模型从工具描述里分辨该用哪个角色。**

若要真正的差异化描述，需要给上游 `dsh-tool-subagent` 增加 `description` 配置项。

### 2.3 运行时挂载的工具不出现在 `--dump-config` 中

`--dump-config` 渲染的是静态配置树（profile 的 bundle 层按序 patch 的结果）。本插件的角色工具通过 `apply()` 内的 `ctx.plugin()` 运行时挂载，产生的是子 fiber 而非声明式配置节点。

**后果**：`--dump-config` 对角色的启停完全不敏感——角色开、关、路由失效三种状态下输出一模一样。它只能验证「bundle 层被识别、插件行被插入」。

**角色工具是否真的挂载，只能由真实模型问答验证，没有静态替代品。**

### 2.4 `toolFilter` 在子代理运行时应用，不在挂载时校验

`toolFilter` 由委派工具的 `execute()` 随启动请求下发，真正的 `tools.restrict()` 发生在子代理创建时。

推论一：同一轮同步内「先挂的实例 deny 了后挂实例的名字」没有顺序风险。

推论二（约束）：`restrict()` 对**未注册**的工具名会抛错。所以 deny 列表只能包含真正挂上的工具名，被健康检查跳过的名字绝不能进去——这是 `planMounts` 分两遍遍历的原因。

### 2.5 headless 一次性执行下 `ctx.logger` 输出不可见

cordis 默认只写内存缓冲，headless 未接控制台 exporter。插件在路由不可用时确实调用了 `logger.warn`，但用户看不到。

这不是插件缺陷（cordis 自身的 fiber 启动失败日志同样不可见），但后果真实：**配错 provider 的用户只看到工具没出现，拿不到任何原因**。已在 README 已知限制中如实披露，替代判据是「以工具是否出现在工具列表为准」。

### 2.6 out-of-tree 插件不应声明 runtime 依赖

profile 的 `pnpm-workspace.yaml` 写死 `nodeLinker: hoisted`，`healProfilesModuleFallback` 把安装侧依赖闭包链接到 `~/.dsh/profiles/node_modules`。out-of-tree 插件正是靠这条路径共享宿主的**单一实例**。

补 `peerDependencies` 反而可能让 pnpm 在 profile 里装出第二份 cordis，导致服务查找失败。官方教程的示例插件同样零依赖声明。

---

## 三、本阶段留下的债

按偿还优先级排列。

### 3.1 抽出可测的协调器（建议在阶段二开工前做）

`src/index.ts` 的挂载记账 + 串行队列 + 增删循环，是本阶段唯一有状态、有时序、有失败路径的逻辑，目前**自动化覆盖率为零**，只由人工推理与一次端到端验收保证。

把「挂载」抽象成注入的 `(spec) => Promise<() => Promise<void>>`，这段逻辑就能用假挂载器覆盖并发同步、重复工具名、挂载失败、卸载失败四条路径。

**阶段三的 `scope.watch()` 重挂载会直接落在这段代码上**，那时再改风险更高。

### 3.2 真实 Loader 组合测试（设计文档 §9 列为最关键，本阶段欠着）

假 `llm` 服务 + 真 Loader，不需要 API key，产出「工具确实注册 / fiber dispose 后确实消失」的**可重放**断言。

当前替代品是 Task 6 的人工端到端验收——它确实覆盖了真实加载路径，但不可重放：阶段二加 skill 注册、阶段三加配置界面之后，没有任何自动化手段能回答「工具还在不在」。

### 3.3 已知的表达力缺口

- `toolFilter` 表达不了「只读 bash」。reviewer 与 researcher 目前 deny 了写工具，但 `bash` 未受限，与设计文档 3.2 节的「只读」表述有出入。
- 用户自定义 deny 若命中一个裁剪过的 profile 里不存在的工具名，会在**每次派发时**抛错而非挂载时暴露。健康检查只覆盖 provider，不覆盖工具名。
- 角色的 `models` 为空数组时静默无输出：不挂工具也不记 skipped，与「停用角色」不可区分。

---

## 四、阶段二（方法论 skill、项目初始化、纪律 gate）开工前须知

- **角色路由指令必须写进 skill 正文**（见 2.2）。`crew` skill 得显式规定「第 N 步调用 `subagent_<role>`」。
- **并行调用多个 reviewer 实例是纯提示词约束**，运行时没有任何机制保证。设计文档 §11 已列为未决问题，gate 侧的检测退路建议一并设计。
- **纪律 gate 选 `ctx.tools.guard()` 还是 `tools/pre-execute` waterfall，语义不同**：guard 是单调的（任何 guard 可拒、无人可强行放行），比 waterfall 更适合「必须带 plan 路径」这种不可被下游覆盖的判据。
- **gate 要识别 implementer 工具，就得知道当前挂了哪些工具名** —— 这个信息目前只活在 `apply()` 的闭包里。抽协调器时顺便让它可查询。
- **skill 注册与角色挂载同属 fiber 生命周期管辖**。若 skill 正文要引用「当前启用了哪些角色」，会引入时序耦合，建议避开：把 skill 正文写成与具体角色集合无关。

## 五、阶段三（配置界面）开工前须知

- `diffMounts` 的配置比对分支到那时才第一次成为活代码。它依赖两个前提：**键序稳定**、**`config` 对象引用跨同步稳定**。而 `applies: 'live'` + `scope.watch()` 恰恰会打破「config 在单次 `apply` 内不可变」这个当前成立的假设。改之前先补上那条 JSDoc，或直接换成结构化比较。
- `ctx.webServer.register()` **不提供任何鉴权**。信任边界（校验 Host 头为回环地址、请求体大小上限）需插件自建，设计文档 7.1 已记录，实现时别丢。
- 角色启停会改变工具集，使**全部会话的模型缓存前缀失效**。配置界面需就此给出明确提示：保存配置的实际代价是下一轮请求全量重新预填充。
