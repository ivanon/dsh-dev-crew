import { describe, expect, it } from 'vitest'
import { checkRoute } from '../src/health.ts'

const live = [{ id: 'deepseek-official' }, { id: 'kimi-coding' }]
const configurable = [{ provider: 'kimi-coding' }, { provider: 'qwen' }]

describe('checkRoute', () => {
  it('reports ready for a registered route', () => {
    expect(checkRoute('deepseek-official', live, configurable)).toBe('ready')
  })

  it('prefers ready over unconfigured when a route appears in both lists', () => {
    // kimi-coding 同时出现在两个列表：已注册即可用，声明状态不改变结论。
    expect(checkRoute('kimi-coding', live, configurable)).toBe('ready')
  })

  it('reports unconfigured for a declared but dormant route', () => {
    expect(checkRoute('qwen', live, configurable)).toBe('unconfigured')
  })

  it('reports missing for a route neither list knows', () => {
    expect(checkRoute('nonexistent', live, configurable)).toBe('missing')
  })

  it('reports missing for an empty provider name', () => {
    // 内置角色的默认空值必须落在 missing，否则默认配置会挂出工具。
    expect(checkRoute('', live, configurable)).toBe('missing')
  })
})
