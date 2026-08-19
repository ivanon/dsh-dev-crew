import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// 仅为触发 `@deepseek-ai/dsh-host-webserver` 对 `@deepseek-ai/cordis` 的
// `declare module` 模块增强：不装它，`ctx.get('webServer')` 落回
// `Context.get(name: string): any` 重载，`server.register(...)` 的调用全在
// `any` 上进行，与真实 `WebServer` 契约的偏差不会被 tsc 发现。
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SkippedRoute } from './mount.ts'
import type { Config } from './types.ts'

/** 回环主机名白名单。精确匹配，不做前缀或包含判断。 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** 请求体上限，防止一个畸形请求占满内存。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 判断请求的 Host 头是否可信。
 *
 * `ctx.webServer.register()` 不提供任何鉴权，信任边界由本插件自建。判断用
 * 精确匹配而非前缀或包含：`evil-localhost.com` 与 `localhost.evil.com` 都
 * 必须被拒绝。
 * @param host - 请求的 Host 头，可能缺失。
 * @param trusted - 部署显式配置的额外可信主机名。
 * @returns 是否放行。
 */
export function isTrustedHost(host: string | undefined, trusted: readonly string[]): boolean {
  if (host === undefined || host === '') return false
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0] ?? ''
  return LOOPBACK.has(name) || trusted.includes(name)
}

/** HTTP 路由的外部依赖。 */
export interface CrewApiDeps {
  readonly readConfig: () => Config
  /** 当前命名空间的 revision，随每次 RAW section 变更单调递增。 */
  readonly readRevision: () => number
  /**
   * 合并写入一份（可能不完整的）配置补丁；`expectedRevision` 不匹配时须抛出
   * `SETTINGS_CONFLICT`。校验发生在实现内部（`settings.update()` 自己的
   * merge-then-validate 流水线），http.ts 不重复解析：调用方提交的补丁本就可能
   * 只含部分顶层字段，一次独立于已持久化值的 schema 解析会把未提交的字段填成
   * schema 默认值，而不是保留原值。
   */
  readonly writeConfig: (patch: object, expectedRevision: number) => Promise<void>
  readonly mountedToolNames: () => readonly string[]
  readonly skippedRoutes: () => readonly SkippedRoute[]
  readonly trustedHosts: readonly string[]
}

/** 读取请求体，超出 {@link MAX_BODY_BYTES} 返回 `undefined`。 */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0
  let overflowed = false
  const chunks: Buffer[] = []
  return new Promise<string | undefined>(resolve => {
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflowed = true
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/**
 * 注册配置读写与健康查询的 HTTP 路由。
 *
 * 三条路由都要求 POST（`GET /health` 除外）与可信 Host。健康路由的存在是为了
 * 补上 headless 下 `logger.warn` 不可见的可观测性缺口：配错 provider 的用户
 * 至少能通过它拿到原因。
 * @param ctx - 注册所在的上下文，需已组合 `webServer`。
 * @param deps - 配置读写与状态查询。
 * @returns 取消注册的 disposer；未组合 `webServer` 的部署返回空 disposer。
 */
export function registerCrewApi(ctx: Context, deps: CrewApiDeps): () => void {
  const server = ctx.get('webServer')
  if (server === undefined) return () => {}

  return server.register({
    kind: 'prefix',
    path: '/crew/api',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const send = (status: number, payload: unknown): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(payload))
      }

      if (!isTrustedHost(req.headers.host, deps.trustedHosts)) {
        send(403, { ok: false, error: { code: 'UNTRUSTED_HOST', message: 'request rejected by the plugin trust fence' } })
        return
      }

      const path = (req.url ?? '').split('?')[0] ?? ''

      if (req.method === 'GET' && path.endsWith('/health')) {
        send(200, { ok: true, value: { mounted: deps.mountedToolNames(), skipped: deps.skippedRoutes() } })
        return
      }

      if (req.method !== 'POST') {
        send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
        return
      }

      if (path.endsWith('/settings.get')) {
        send(200, { ok: true, value: { config: deps.readConfig(), revision: deps.readRevision() } })
        return
      }

      if (path.endsWith('/settings.update')) {
        const body = await readBody(req)
        if (body === undefined) {
          send(413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: `body exceeds ${MAX_BODY_BYTES} bytes` } })
          return
        }
        try {
          const parsed = JSON.parse(body) as { config?: unknown; expectedRevision?: unknown }
          if (typeof parsed.expectedRevision !== 'number') {
            send(400, { ok: false, error: { code: 'MISSING_REVISION', message: 'expectedRevision is required; read it from settings.get' } })
            return
          }
          if (typeof parsed.config !== 'object' || parsed.config === null) {
            send(400, { ok: false, error: { code: 'INVALID_CONFIG', message: 'config must be a JSON object' } })
            return
          }
          // 写入前必须校验：HTTP 是不可信输入边界。校验发生在 `deps.writeConfig`
          // 内部（`settings.update()` 自己对 schema 的校验），而不是在这里独立
          // 再解析一次——后者会把调用方省略的顶层字段固化成 schema 默认值。
          await deps.writeConfig(parsed.config, parsed.expectedRevision)
          send(200, { ok: true, value: { config: deps.readConfig(), revision: deps.readRevision() } })
        } catch (error: unknown) {
          if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT') {
            send(409, {
              ok: false,
              error: { code: 'REVISION_CONFLICT', message: 'the configuration changed since you loaded it; reload and reapply your edits' },
            })
            return
          }
          send(400, { ok: false, error: { code: 'INVALID_CONFIG', message: String(error) } })
        }
        return
      }

      send(404, { ok: false, error: { code: 'UNKNOWN_ROUTE', message: path } })
    },
  })
}
