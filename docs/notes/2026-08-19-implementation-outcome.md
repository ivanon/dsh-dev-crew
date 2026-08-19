# 实施收尾记录：三个阶段查证出的上游事实与技术债

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

### 3.4 互斥 deny 的级联重挂载（Task 1 补测协调器时查证）

**现象**：`CrewCoordinator` 的并发同步测试按最初写法跑会失败——不是协调器的并发逻辑有问题，而是当同一次 `sync` 的就绪角色集合从 `{A}` 变成 `{A, B}` 时，`A` 自身的 `config`（未改 provider/model/persona）也发生了变化，被 `diffMounts` 判定为需要重挂载。

**根因**：`planMounts` 的互斥 deny（`denyOtherCrewTools`，见 `src/mount.ts`）给每个就绪角色的 `toolFilter.deny` 追加「本次调用里其他就绪角色的工具名」。这个列表由当次调用的**整个就绪集合**推导，与角色 id 是否命中 `BUILTIN_ROLES` 无关：任何第二个就绪角色的出现或消失，都会改写所有其他既有就绪角色的 `deny` 列表。`diffMounts` 按 `JSON.stringify(config)` 判等，deny 列表变化即被判定为「配置变了」，触发卸载重挂。

**对阶段三配置热更新的含义**：阶段三让角色开关经由 `scope.watch()` 直接触发重同步。这意味着**用户开关任意一个角色，都会连带卸载重挂当前全部其他就绪角色的委派工具**，而不只是被开关的那一个。每次重挂对应的模型请求前缀缓存失效一次——单个角色的开关操作，代价是全体就绪角色的缓存前缀一起失效，而不是局部的。这一点比本文件 §5 已记录的「角色启停会让工具集变化、使会话缓存前缀失效」更具体：不是「变化的那个角色」失效，是「当时全部就绪角色」一起失效。配置界面若要如实提示保存代价，需要按这条更精确的范围来提示，而不是只提被改动的角色。

**当前判断**：这是「子代理必须看不到其他委派工具」这条设计需求的自然后果，不是待修的缺陷。`toolFilter.deny` 目前没有不引发重挂载就能更新的机制（阶段一未提供原地更新路径，见 `diffMounts` 的 JSDoc），若未来要压低这个级联半径，需要在 `mount.ts` 侧改变 deny 的推导或引入原地更新，而不是在协调器侧兜底。

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

---

# 阶段二、三补记（2026-08-19 实施后）

阶段二（方法论 skill、产物目录初始化、纪律 gate）与阶段三（配置界面）实施完成，123 个测试。以下是这两个阶段查证出的、**代码本身读不出来**的上游事实与教训，与上文并列作为后续工作的输入。

## 六、`ctx.get()` 分不清「服务不存在」与「服务还没加载完」

这是本轮最贵的一课，同一个错误出现了**三次**（`webServer`、`settings`、`commands`）。

`ctx.get('someService')` 是**一次性快照读取**。在 `apply()` 里用它判断可选服务是否存在，写出的是这样的代码：

```ts
const server = ctx.get('webServer')
if (server === undefined) return () => {}   // 「优雅降级」
```

问题在于：服务**晚一步注册**时，这里同样返回 `undefined`。于是「该部署没有这个服务」与「这个服务还没加载完」被当成了同一件事，注册被永久静默错过 —— 没有报错、没有日志，`npm run check` 全绿，而功能从头到尾没工作过。

**正确机制是 `ctx.inject(deps, callback)`**（cordis `registry.d.ts:111,185`，等价于 `ctx.plugin({ inject: deps, apply: callback })`）：

- 依赖未就绪时停在 PENDING 的是**那个子插件**，主插件照常工作
- 依赖就绪后 callback 自动执行，依赖消失时自动回收
- 回调里必须用**回调参数那个 ctx** 注册效果，否则服务消失时不会正确回收

**机制上不存在竞态窗口**：`ctx.reflect.provide()` 在提供方 fiber 变为 ACTIVE 时调用 `notify()`，而 `notify()` 会遍历**所有**声明了该服务名的 fiber 使其重新评估 epoch。这是由状态转换因果触发的响应式机制，与两个插件谁先执行无关。

**不能把可选服务加进主插件的顶层 `inject`**：cordis 的 `Inject` 类型是 `(keyof M)[] | { [K]?: config }`，**没有 required/optional 之分**。headless 部署没有 `webServer`，加进去会让整个插件永久 PENDING —— 那比原缺陷更严重。

**与 dsh 包规范的关系**：规范写的是「可选服务用 `ctx.get(name)`」。那条规范针对的是**读取服务实例**这个动作，是对的；而「注册一个需要长期有效的效果」对加载时序有额外要求，规范没有区分这两种场景。`tests/loader.test.ts` 里那三条「服务晚于插件就绪」的用例就是为此存在的 —— 有人照着规范把 `ctx.inject` 改回 `ctx.get` 时，它们会红。

## 七、委派工具默认后台，只返回 id

`dsh-tool-subagent` 在 `backgroundMode: continuable` 下，`run_in_background` **默认为 true**。调用立刻返回的是 `started subagent <id>`，**不是报告**；报告经 runtime 的完成通知到达。

这条直接决定方法论正文怎么写。初版 `crew-converge.md` 写的是「拿到全部报告后分类阻塞项」，两个分支都会坏：

- 用默认（后台）→ 模型拿到一串 id、看不到任何阻塞项 → **判定「无阻塞、收敛」**，正是收敛协议要防的假阳性
- 传 `run_in_background: false` 走前台 → **不产生持久子代理 id** → `send_message` 复审从此不可能

正文必须写明：保持后台默认、返回值是 id、等完成通知全部到齐再分类、用 `list_agents` 查看谁还在 running。

## 八、`list_agents` 列的是子代理，不是工具

`list_agents` 返回已存在的子代理会话，与「当前挂载了哪些工具」无关。预检门若用它确认角色工具是否就位，在流水线开始时必然拿到空列表。要看工具就看自己的工具清单。

## 九、gate 的路径候选正则必须排除中文全角标点

模型自然转述路径时会写「计划文件：docs/plans/x.md」或「按（docs/plans/x.md）实现」。若正则只排除 ASCII 标点，路径会被全角冒号/括号/逗号粘住而被误拒，**而拒绝理由不会提示原因**，模型可能反复重试。

这条缺陷只有真实模型用中文说人话时才暴露 —— 单元测试里的路径字符串都是干净的。

## 十、客户端契约（实测，无一条能从文档推出）

- 客户端产物是**惰性 CJS**（`window.__ModuleLoader__.load({ id, factory })` 包装），不是 ESM
- `package.json` 的 `dsh.client.inject` 是**客户端包名清单**，与运行时 `export const inject`（cordis 服务名）是**两套独立清单**
- 宿主 `packages/host/apiproxy` 里有**硬编码的 settings 命名空间白名单**，第三方插件的命名空间不在其中 —— 所以插件自己的配置读写必须走自建 HTTP 路由，`settings.section` 只是挂载点
- `dsh-context` 虽有客户端半部，但**不含 `settings.section` 用例**；带该用例的是 `dsh-at-file` 与 `dsh-better-sidebar`

## 十一、settings 的写路径语义

- `update(ns, patch, expectedRevision)` 深合并 patch 进用户 section，**先合并已持久化值再校验**
- `replace(ns, section, ...)` 整体替换
- 文档专门警告：**配置 UI 读的是 redacted 描述符，拿它重建 section 再整体 replace，会删掉 wire 从未返回的每一个 secret**

由此得出一条容易踩的坑：**在 HTTP 层先用 `ConfigSchema()` 独立解析一次再写入，会把调用方省略的顶层字段填成 schema 默认值**。此后交给 `update()` 还是 `replace()` 结果完全一样 —— 深合并面对一个键齐全的对象，等同于整体替换。正确做法是把原始（可能不完整的）JSON 直接交给 `update()`，让 settings 服务自己的 merge-then-validate 处理。

- `describe()` 作为 wire surface **必须传 `redactSecrets: true`**，且要确保脱敏结果真正接入流出 wire 的数据路径 —— 只在一条取 `revision` 的旁路上调用它，是形式满足、实质落空。
- `SettingsScope` 上**没有 `dispose()` 方法**（只有 `get`/`watch`/`update`/`replace`）；注销由 `register()` 内部挂在调用方 fiber 的 `ctx.effect()` 负责。
- `register()` 的 `ns` 参数要求 `Branded<'SettingsNamespace'>`，必须用 `settingsNamespace()` 工厂包装，裸 string 编译不过。
- `SettingsRegisterOptions<T>.base` 的类型是 `Partial<T>`（注释即「entry-config subset」）。

## 十二、`artifactDirs` 是无语义标签的字符串数组

`crew_init` 返回 `created`/`skipped` 两个数组，各自只保留组内相对顺序。**混合切分时无法从返回值还原哪条路径对应 specs/plans/reports** —— `created=[P]`、`skipped=[S,R]` 有三种自洽排列。而 `artifactDirs` 本身也没有长度为 3 的校验。

**插件自己都不知道哪一项是 reports。** 正文层面无解，正确的修法是把配置改成带语义键的结构（`{ specs, plans, reports }`）。当前的处置是让正文诚实承认无法推断、要求停下来问用户 —— 因为**一条有漏洞的规则比没有规则更糟**：没有规则时模型知道自己不知道，有了漏洞规则它会自信地把产物写进错目录，而且不会有任何报错。

## 十三、阶段二三留下的债

- **`artifactDirs` 应改为带语义键的配置结构**（见上条）
- **客户端 `CrewSection` 未做浏览器级验收**：三态健康显示、保存失败保留输入、KV 缓存提示、零凭据字段四条判据均在代码层确认，但未在真实浏览器中人工核对
- **UI 不能编辑 `artifactDirs` 与 `gate.plansDir`**：只读展示，改路径仍需手改配置文件
- **`gate.enabled` 不支持热切换**：界面可编辑该开关，但需重载插件才生效（界面已加提示）
- **`trustedHosts` 硬编码 `[]`**：企业内网部署无法扩展白名单，且无对应 Config 字段
- **CSRF**：Host 白名单挡不住浏览器页面向 localhost 发 POST，当前定位是「仅本地信任环境」
- **`process.cwd()` 作为 gate 围栏与初始化基准**：monorepo 子目录或远程工作区启动时可能错位
- **大小写不敏感文件系统上的围栏比较**：`startsWith` 前缀比对未处理大小写差异
- **skill 正文读不到运行时配置**：`pipeline.maxConvergenceRounds` 等只能靠正文写默认值缓解，根治需要一个只读的 `crew_status` 工具
- **`crew_init` 的工具描述硬编码了默认目录名**，与可配置的 `artifactDirs` 可能给模型矛盾信号
