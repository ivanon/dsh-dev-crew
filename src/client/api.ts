/** 与 host 侧 fenced 路由通信的最小封装。 */
export interface CrewApiResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * 调用插件自有的 fenced 路由。
 * @param path - `/crew/api` 之后的路径片段。
 * @param body - POST 请求体；省略则发 GET。
 * @returns 服务端返回的结果封装。
 */
export async function callCrewApi<T>(path: string, body?: unknown): Promise<CrewApiResult<T>> {
  const response = await fetch(`/crew/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  return await response.json() as CrewApiResult<T>
}
