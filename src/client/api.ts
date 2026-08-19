/** 与 host 侧 fenced 路由通信的最小封装。 */
export interface CrewApiResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * 调用插件自有的 fenced 路由。
 *
 * `fetch` 本身失败（网络断开、host 未起）与响应体不是合法 JSON（例如宿主的
 * fallback 处理器答了一个 HTML 页面）都不会抛给调用方：两者都折叠成
 * `CrewApiResult.ok === false`，好让 `CrewSection.tsx` 已有的错误展示路径接住，
 * 而不是让界面停在 Loading 或抛出未捕获异常。
 * @param path - `/crew/api` 之后的路径片段。
 * @param body - POST 请求体；省略则发 GET。
 * @returns 服务端返回的结果封装；网络或响应解析失败时返回本地合成的失败结果。
 */
export async function callCrewApi<T>(path: string, body?: unknown): Promise<CrewApiResult<T>> {
  let response: Response
  try {
    response = await fetch(`/crew/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, error: { code: 'NETWORK_ERROR', message: `request to /crew/api/${path} failed: ${message}` } }
  }
  try {
    return await response.json() as CrewApiResult<T>
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      ok: false,
      error: {
        code: 'INVALID_RESPONSE',
        message: `response from /crew/api/${path} (status ${response.status}) was not valid JSON: ${message}`,
      },
    }
  }
}
