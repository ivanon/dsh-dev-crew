import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('plugin module', () => {
  it('exports a name and an apply function as named exports', () => {
    expect(plugin.name).toBe('dsh-dev-crew')
    expect(typeof plugin.apply).toBe('function')
  })

  it('has no default export', () => {
    // 默认导出会让 Loader 的 unwrapExports 取 .default 而丢弃 inject 等具名导出。
    expect((plugin as Record<string, unknown>).default).toBeUndefined()
  })
})
