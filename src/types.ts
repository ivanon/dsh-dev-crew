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
  /** 纪律 gate 配置。 */
  gate: {
    /** 是否启用。关闭只移除运行时强制，skill 正文仍要求传递路径。 */
    enabled: boolean
    /** plans 目录，相对路径按插件进程的 cwd 解析。 */
    plansDir: string
  }
  /** 流程产物目录，相对项目根。 */
  artifactDirs: string[]
  /** 流水线参数。 */
  pipeline: {
    /** 每个评审环节的收敛轮数上限。达到上限仍有阻塞项则转遗留清单。 */
    maxConvergenceRounds: number
  }
}
