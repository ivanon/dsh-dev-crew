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

  it('supplies pipeline defaults', () => {
    expect(new Config({}).pipeline.maxConvergenceRounds).toBe(3)
  })

  it('supplies gate defaults', () => {
    const gate = new Config({}).gate
    expect(gate.enabled).toBe(true)
    expect(gate.plansDir).toBe('docs/plans')
  })

  it('supplies artifact directory defaults', () => {
    expect(new Config({}).artifactDirs).toEqual(['docs/specs', 'docs/plans', 'docs/reports'])
  })

  it('rejects a convergence limit outside the allowed range', () => {
    expect(() => new Config({ pipeline: { maxConvergenceRounds: 0 } })).toThrow()
  })
})

/**
 * dsh 宿主的全局工具名，2026-08-19 从 `tools.restrict()` 拒绝未知名字时打印的
 * `known global tools` 列表逐项抄录（宿主 0.1.0-rc.7）。
 *
 * 这份清单会随宿主演进过期，它的作用不是永久真理，而是强制核对：`restrict()`
 * 对未知工具名**抛错而不是忽略**，所以内置角色的 deny 里出现一个不存在的名字，
 * 会让该角色在委派时直接失败。0.1.0 就因为 deny 了 `str_replace_editor`
 * （Anthropic 工具生态的名字，dsh 用 `edit`/`write`）而使 reviewer 与 researcher
 * 开箱不可用。改动 deny 前，先用真实宿主的这条错误信息核对名字是否存在。
 */
const KNOWN_DSH_TOOLS = new Set([
  'ask_user_question', 'bash', 'edit', 'glob', 'grep', 'list_agents', 'read', 'read_image',
  'skill', 'subagent', 'subagent_fork', 'todo_write', 'web_search', 'workflow', 'write',
])

describe('builtin role tool filters', () => {
  it('only deny tool names the host actually registers', () => {
    for (const role of BUILTIN_ROLES) {
      for (const name of role.toolFilter?.deny ?? []) {
        expect(
          KNOWN_DSH_TOOLS.has(name),
          `role "${role.id}" denies "${name}", which is not a known dsh global tool; `
          + 'restrict() throws on unknown names, so this makes the role unusable',
        ).toBe(true)
      }
    }
  })

  it('never set an empty allow list, which would strip every tool', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.toolFilter?.allow, `role "${role.id}"`).not.toEqual([])
    }
  })
})

describe('builtin personas', () => {
  it('require every role to report back explicitly', () => {
    // 子代理结束一轮不会自动回传，宿主自带的提示是 guidance 而非 enforcement
    // （dsh-tool-subagent-report 的原话），所以 persona 必须自己要求 report。
    // 少了这一句，编排者会正确地等，但永远等不到东西。
    for (const role of BUILTIN_ROLES) {
      expect(role.persona, `role "${role.id}"`).toContain('`report`')
    }
  })

  it('tell each role that its own transcript is not visible to the parent', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.persona, `role "${role.id}"`).toContain('transcript')
    }
  })
})
