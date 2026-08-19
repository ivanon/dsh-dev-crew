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
    expect(new Config({}).artifactDirs)
      .toEqual(['docs/specs', 'docs/plans', 'docs/reviews', 'docs/reports'])
  })

  it('includes a reviews directory so review findings have somewhere to land', () => {
    // 评审意见由编排者落盘——reviewer 的 toolFilter 拒了 write/edit——所以这个
    // 目录必须和 specs/plans/reports 一样在 crew_init 时就建好。
    expect(new Config({}).artifactDirs).toContain('docs/reviews')
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

describe('reviewer write access', () => {
  it('lets the reviewer write, so it can land its own review file', () => {
    // 意见由 reviewer 自己落盘，全文因此不必挤进「只有最后一条消息会被带回」
    // 那个通道。代价记录在 config.ts 对应的注释里：`write` 的语义是 create or
    // fully replace，工具级已无法阻止它覆盖产物，纪律靠 persona 的路径约定。
    const reviewer = BUILTIN_ROLES.find(role => role.id === 'reviewer')
    expect(reviewer?.toolFilter?.deny).not.toContain('write')
  })

  it('still denies edit, which has nothing to do with writing a new report', () => {
    const reviewer = BUILTIN_ROLES.find(role => role.id === 'reviewer')
    expect(reviewer?.toolFilter?.deny).toContain('edit')
  })

  it('keeps the researcher unable to write', () => {
    // 只有 reviewer 需要落盘；researcher 的产出直接回给编排者。
    const researcher = BUILTIN_ROLES.find(role => role.id === 'researcher')
    expect(researcher?.toolFilter?.deny).toContain('write')
  })

  it('tells the reviewer to write only the file it was given', () => {
    const reviewer = BUILTIN_ROLES.find(role => role.id === 'reviewer')
    expect(reviewer?.persona).toContain('Write ONLY that file')
  })

  it('tells the reviewer to end with a short summary, not the full findings', () => {
    const reviewer = BUILTIN_ROLES.find(role => role.id === 'reviewer')
    expect(reviewer?.persona).toContain('SHORT summary')
  })
})

describe('builtin personas', () => {
  it('tell every role to put its conclusion in the final message', () => {
    // 结算通知只带回子代理最后一条消息（ActivationTerminal.output 是 "the epoch's
    // final assistant content"），写在前面的内容对编排者不可见。
    for (const role of BUILTIN_ROLES) {
      expect(role.persona, `role "${role.id}"`).toContain('FINAL message')
    }
  })

  it('tell every role its transcript is invisible to the delegating agent', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.persona, `role "${role.id}"`).toContain('transcript')
    }
  })

  it('offer report as a mid-flight channel rather than the only one', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.persona, `role "${role.id}"`).toContain('`report`')
    }
  })
})
