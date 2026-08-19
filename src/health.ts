/**
 * 一个 provider 路由对本插件的可用状态。
 *
 * 判据分别取自 `ctx.llm.listProviders()`（已注册的活路由）与
 * `ctx.llm.listConfigurableProviders()`（声明了但尚未激活的路由）。注意两个
 * 接口的路由键字段名不同：前者是 `id`，后者是 `provider`。
 */
export type RouteHealth = 'ready' | 'unconfigured' | 'missing'

/** `ctx.llm.listProviders()` 条目中本模块关心的字段。 */
export interface LiveProvider {
  id: string
}

/** `ctx.llm.listConfigurableProviders()` 条目中本模块关心的字段。 */
export interface ConfigurableProvider {
  provider: string
}

/**
 * 判定一个 provider 路由的可用状态。
 * @param provider - 待判定的路由键；空字符串一律判为 missing。
 * @param live - 当前已注册的 provider 路由。
 * @param configurable - 已声明可通过配置激活的 provider 路由。
 * @returns 该路由的健康状态。
 */
export function checkRoute(
  provider: string,
  live: readonly LiveProvider[],
  configurable: readonly ConfigurableProvider[],
): RouteHealth {
  if (provider === '') return 'missing'
  if (live.some(entry => entry.id === provider)) return 'ready'
  if (configurable.some(entry => entry.provider === provider)) return 'unconfigured'
  return 'missing'
}
