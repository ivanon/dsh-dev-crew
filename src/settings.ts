import type { Context } from '@deepseek-ai/cordis'
// 仅为触发 `@deepseek-ai/dsh-settings` 对 `@deepseek-ai/cordis` 的 `declare module`
// 模块增强：不装它，`ctx.get('settings')` 落回 `Context.get(name: string): any`
// 重载，`settings.register(...)`/`scope.watch(...)` 等调用全在 `any` 上进行，
// 与真实 `SettingsProvider`/`SettingsScope` 契约的偏差不会被 tsc 发现。
import type {} from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config as ConfigSchema } from './config.ts'
import type { Config } from './types.ts'

/** 本插件的用户设置命名空间。 */
export const SETTINGS_NAMESPACE = settingsNamespace('dsh-dev-crew')

/**
 * 注册用户设置命名空间，并把解析后的配置推给调用方。
 *
 * 未组合 settings 服务的部署（例如 headless）不应因此失败：此时返回一个空
 * disposer，插件继续使用 cordis.yml 的入口配置。用 `ctx.get()` 而非属性代理，
 * 因为后者对拓扑敏感，未声明注入时读取会抛错。
 *
 * 返回的 disposer 只 `unwatch()`：真正的注销由 `SettingsProvider.register()`
 * 内部挂在调用方 fiber 上的 `ctx.effect()` 负责——那个 fiber 释放时命名空间与
 * 全部观察者一并移除。`SettingsScope` 上没有 `dispose` 方法，调用方不需要、
 * 也不能自行触发注销；不要为此重新加一个 `dispose()` 调用。
 * @param ctx - 注册所在的上下文。
 * @param base - 组合层的配置，作为用户文档的叠加基底；类型与 {@link ConfigSchema}
 *   声明的输入类型一致（`Partial<Config>`），未提供的字段由 schema 默认值填充。
 * @param onChange - 初始值与每次变更都会调用，参数是 schema 解析后的完整配置。
 * @returns 取消监听的 disposer。
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

  return unwatch
}
