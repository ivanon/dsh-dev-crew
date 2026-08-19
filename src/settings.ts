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
 * @param base - 组合层的配置，作为用户文档的叠加基底；类型与 {@link ConfigSchema}
 *   声明的输入类型一致（`Partial<Config>`），未提供的字段由 schema 默认值填充。
 * @param onChange - 初始值与每次变更都会调用，参数是 schema 解析后的完整配置。
 * @returns 取消注册与监听的 disposer。
 */
export function registerCrewSettings(
  ctx: Context,
  base: Partial<Config>,
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
