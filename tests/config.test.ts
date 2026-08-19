import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, Config } from '../src/config.ts'

describe('Config schema', () => {
  it('supplies the three builtin roles when the section is absent', () => {
    const value = new Config({})
    expect(value.roles.map(role => role.id)).toEqual(['implementer', 'reviewer', 'researcher'])
  })

  it('disables every builtin role by default', () => {
    const value = new Config({})
    expect(value.roles.every(role => role.enabled === false)).toBe(true)
  })

  it('leaves builtin provider and model empty so no author-local route ships', () => {
    for (const role of BUILTIN_ROLES) {
      for (const model of role.models) {
        expect(model.provider).toBe('')
        expect(model.model).toBe('')
      }
    }
  })

  it('denies delegation tools to the implementer role', () => {
    const implementer = BUILTIN_ROLES.find(role => role.id === 'implementer')
    expect(implementer?.toolFilter?.deny).toContain('subagent')
  })

  it('accepts a user-supplied role list verbatim', () => {
    const value = new Config({
      roles: [{
        id: 'solo',
        enabled: true,
        models: [{ alias: 'a', provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
      }],
    })
    expect(value.roles).toHaveLength(1)
    expect(value.roles[0]!.models[0]!.model).toBe('deepseek-v4-flash')
  })

  it('leaves an omitted toolFilter undefined instead of materializing an empty one', () => {
    // `allow: []` 的语义是「只保留这零个工具」，即移除全部工具。一个未配置
    // 工具范围的角色若被物化成空过滤器，其子代理会一个工具都拿不到。
    const value = new Config({
      roles: [{
        id: 'solo',
        enabled: true,
        models: [{ alias: 'a', provider: 'p', model: 'm' }],
      }],
    })
    expect(value.roles[0]!.toolFilter).toBeUndefined()
  })

  it('leaves an omitted allow list undefined inside a supplied toolFilter', () => {
    const value = new Config({
      roles: [{
        id: 'solo',
        enabled: true,
        models: [{ alias: 'a', provider: 'p', model: 'm' }],
        toolFilter: { deny: ['subagent'] },
      }],
    })
    expect(value.roles[0]!.toolFilter!.allow).toBeUndefined()
    expect(value.roles[0]!.toolFilter!.deny).toEqual(['subagent'])
  })
})
