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

## 已知限制

- 角色的启停会改变工具集，使全部会话的模型缓存前缀失效，下一轮请求需重新预填充。
- 子代理后端固定为 `spawn`（干净上下文）。不提供 fork：fork 的前缀复用收益会被
  continuable 子代理装入请求头部的内容抵消。
- 路由不可用时对应的 `subagent_<role>` 工具不会挂载，插件会调用
  `ctx.logger().warn()` 记录原因，但在 `dsh --profile <name> "<task>"` 这类
  headless 一次性执行模式下，该日志当前不会打印到终端（宿主未接控制台输出
  exporter，消息只留在 cordis 的内存日志缓冲区）。判断路由是否生效，请以对应
  `subagent_<role>` 工具是否出现在工具列表中为准，而非等待一行警告文本。

## 许可

MIT
