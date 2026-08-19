import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isTrustedHost, registerCrewApi } from '../src/http.ts'
import type { Config } from '../src/types.ts'

describe('isTrustedHost', () => {
  const trusted: string[] = []

  it('accepts loopback hosts with a port', () => {
    for (const host of ['localhost:3080', '127.0.0.1:3080', '[::1]:3080']) {
      expect(isTrustedHost(host, trusted)).toBe(true)
    }
  })

  it('accepts loopback hosts without a port', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isTrustedHost(host, trusted)).toBe(true)
    }
  })

  it('rejects a missing Host header', () => {
    expect(isTrustedHost(undefined, trusted)).toBe(false)
  })

  it('rejects a non-loopback host', () => {
    expect(isTrustedHost('example.com', trusted)).toBe(false)
  })

  it('rejects a host that merely contains a loopback name', () => {
    // 防止 startsWith/includes 式的宽松判断放行 evil-localhost.com
    expect(isTrustedHost('evil-localhost.com', trusted)).toBe(false)
    expect(isTrustedHost('localhost.evil.com', trusted)).toBe(false)
  })

  it('rejects other 127.x addresses not explicitly trusted', () => {
    expect(isTrustedHost('127.0.0.2:3080', trusted)).toBe(false)
  })

  it('accepts an explicitly configured trusted host', () => {
    expect(isTrustedHost('dev.internal:8080', ['dev.internal'])).toBe(true)
  })
})

/** 构造一对最小的 req/res 替身，返回 res 收到的状态码与解析后的 body。 */
function invoke(handler: (req: never, res: never) => Promise<void>, options: {
  method: string
  url: string
  host?: string
  body?: string
}): Promise<{ status: number; payload: { ok: boolean; error?: { code: string }; value?: unknown } }> {
  return new Promise(resolve => {
    const listeners: Record<string, ((chunk?: unknown) => void)[]> = {}
    const req = {
      method: options.method,
      url: options.url,
      headers: { host: options.host ?? 'localhost:3080' },
      on(event: string, cb: (chunk?: unknown) => void) {
        ;(listeners[event] ??= []).push(cb)
        if (event === 'end') {
          queueMicrotask(() => {
            if (options.body !== undefined) {
              for (const on of listeners.data ?? []) on(Buffer.from(options.body))
            }
            for (const on of listeners.end ?? []) on()
          })
        }
      },
    }
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body?: string) {
        resolve({ status: res.statusCode, payload: JSON.parse(body ?? '{}') })
      },
    }
    void handler(req as never, res as never)
  })
}

/** 内置角色以外、供测试使用的最小合法配置。 */
function testConfig(): Config {
  return {
    roles: [],
    gate: { enabled: true, plansDir: 'docs/plans' },
    artifactDirs: ['docs/specs', 'docs/plans', 'docs/reports'],
    pipeline: { maxConvergenceRounds: 3 },
  }
}

/**
 * 构造一个记录 handler 的 `webServer` 替身，用它调 `registerCrewApi`，返回
 * 捕获到的 handler。`options.writeError` 在给出时替代默认的成功写入。
 */
function buildTestHandler(options: {
  revision: number
  writeError?: unknown
}): (req: never, res: never) => Promise<void> {
  let captured: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined

  const webServer = {
    register(route: { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      captured = route.handler
      return () => {}
    },
  }
  const ctx = {
    get: (name: string) => (name === 'webServer' ? webServer : undefined),
  } as unknown as Context

  registerCrewApi(ctx, {
    readConfig: () => testConfig(),
    readRevision: () => options.revision,
    writeConfig: async () => {
      if (options.writeError !== undefined) throw options.writeError
    },
    mountedToolNames: () => [],
    skippedRoutes: () => [],
    trustedHosts: [],
  })

  if (captured === undefined) throw new Error('registerCrewApi did not register a route')
  return captured as never
}

describe('crew api routes', () => {
  it('rejects settings.update without an expectedRevision', async () => {
    const handler = buildTestHandler({ revision: 7 })
    const result = await invoke(handler, {
      method: 'POST',
      url: '/crew/api/settings.update',
      body: JSON.stringify({ config: { roles: [] } }),
    })
    expect(result.status).toBe(400)
    expect(result.payload.error?.code).toBe('MISSING_REVISION')
  })

  it('maps a settings conflict to REVISION_CONFLICT', async () => {
    const conflict = Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })
    const handler = buildTestHandler({ revision: 7, writeError: conflict })
    const result = await invoke(handler, {
      method: 'POST',
      url: '/crew/api/settings.update',
      body: JSON.stringify({ config: { roles: [] }, expectedRevision: 3 }),
    })
    expect(result.status).toBe(409)
    expect(result.payload.error?.code).toBe('REVISION_CONFLICT')
  })

  it('rejects a config that fails schema validation', async () => {
    const handler = buildTestHandler({ revision: 7 })
    const result = await invoke(handler, {
      method: 'POST',
      url: '/crew/api/settings.update',
      body: JSON.stringify({ config: { pipeline: { maxConvergenceRounds: 0 } }, expectedRevision: 7 }),
    })
    expect(result.status).toBe(400)
    expect(result.payload.error?.code).toBe('INVALID_CONFIG')
  })

  it('returns the current revision from settings.get', async () => {
    const handler = buildTestHandler({ revision: 7 })
    const result = await invoke(handler, { method: 'POST', url: '/crew/api/settings.get' })
    expect(result.status).toBe(200)
    expect((result.payload.value as { revision: number }).revision).toBe(7)
  })

  it('rejects an untrusted host before doing any work', async () => {
    const handler = buildTestHandler({ revision: 7 })
    const result = await invoke(handler, {
      method: 'POST',
      url: '/crew/api/settings.get',
      host: 'evil.com',
    })
    expect(result.status).toBe(403)
    expect(result.payload.error?.code).toBe('UNTRUSTED_HOST')
  })
})
