/**
 * 客户端半部：在 dsh 设置面板注册一个 `settings.section` 区块。
 *
 * 注册方式实测自 `dsh-at-file` / `dsh-better-sidebar`（用户机器上正常工作的
 * 第三方插件，`~/.dsh/profiles/web/node_modules/`）：`ctx.slots.inject(key,
 * factory)` 把 `factory` 内的 `ctx.slots.register()` 推迟到 'settings.section'
 * 这个槽位被宿主的设置外壳（ui-settings-general）声明之后再执行，disposer
 * 绑定在调用者的 fiber 上，不需要额外套 `ctx.effect()`。
 */
// 仅为触发 `@deepseek-ai/dsh-client-runtime` 对 `@deepseek-ai/cordis` 的
// `declare module` 增强（`ctx.slots`）与 `@deepseek-ai/dsh-client-ui-settings`
// 对 `SlotMap` 的增强（'settings.section' 槽位契约）。
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CrewSection } from './CrewSection.tsx'

export const name = 'dsh-dev-crew'
/** cordis 服务名（运行时 DI），与 `package.json` 的 `dsh.client.inject`（npm 包名）是两套不同的清单。 */
export const inject = ['slots']

/**
 * 注册 Dev Crew 的设置区块。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dev-crew',
    order: 60,
    label: 'Dev Crew',
  }, CrewSection))
}
