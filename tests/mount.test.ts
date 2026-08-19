import { describe, expect, it } from 'vitest'
import { planMounts, toolNameFor } from '../src/mount.ts'
import type { CrewRole } from '../src/types.ts'

const live = [{ id: 'deepseek-official' }, { id: 'kimi-coding' }]
const configurable = [{ provider: 'qwen' }]

function role(partial: Partial<CrewRole> & Pick<CrewRole, 'id' | 'models'>): CrewRole {
  return { enabled: true, ...partial }
}

describe('toolNameFor', () => {
  it('omits the alias suffix for a single-model role', () => {
    const single = role({ id: 'implementer', models: [{ alias: 'default', provider: 'p', model: 'm' }] })
    expect(toolNameFor(single, single.models[0]!)).toBe('subagent_implementer')
  })

  it('appends the alias for a multi-model role', () => {
    const multi = role({
      id: 'reviewer',
      models: [
        { alias: 'ds', provider: 'p', model: 'm' },
        { alias: 'kimi', provider: 'q', model: 'n' },
      ],
    })
    expect(toolNameFor(multi, multi.models[1]!)).toBe('subagent_reviewer_kimi')
  })
})

describe('planMounts', () => {
  it('plans one mount per model of an enabled role with ready routes', () => {
    const roles = [role({
      id: 'reviewer',
      models: [
        { alias: 'ds', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { alias: 'kimi', provider: 'kimi-coding', model: 'k3' },
      ],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs.map(spec => spec.toolName))
      .toEqual(['subagent_reviewer_ds', 'subagent_reviewer_kimi'])
    expect(plan.skipped).toEqual([])
  })

  it('skips a disabled role entirely', () => {
    const roles = [role({
      id: 'implementer',
      enabled: false,
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('skips an unconfigured route and records why', () => {
    const roles = [role({
      id: 'researcher',
      models: [{ alias: 'default', provider: 'qwen', model: 'Qwen3' }],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs).toEqual([])
    expect(plan.skipped).toEqual([
      { toolName: 'subagent_researcher', provider: 'qwen', reason: 'unconfigured' },
    ])
  })

  it('skips a missing route and records why', () => {
    const roles = [role({
      id: 'researcher',
      models: [{ alias: 'default', provider: 'nope', model: 'x' }],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.skipped[0]!.reason).toBe('missing')
  })

  it('mounts the ready models of a role whose other models are not ready', () => {
    const roles = [role({
      id: 'reviewer',
      models: [
        { alias: 'ds', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { alias: 'qw', provider: 'qwen', model: 'Qwen3' },
      ],
    })]
    const plan = planMounts(roles, live, configurable)
    expect(plan.specs).toHaveLength(1)
    expect(plan.specs[0]!.toolName).toBe('subagent_reviewer_ds')
    expect(plan.skipped).toHaveLength(1)
  })

  it('pins every spec to the spawn backend and continuable mode', () => {
    const roles = [role({
      id: 'implementer',
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
    })]
    const spec = planMounts(roles, live, configurable).specs[0]!
    expect(spec.config.provider).toBe('spawn')
    expect(spec.config.backgroundMode).toBe('continuable')
  })

  it('carries persona, toolFilter and maxTokens into the mount config', () => {
    const roles = [role({
      id: 'implementer',
      persona: 'you implement',
      toolFilter: { deny: ['subagent'] },
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm', maxTokens: 4096 }],
    })]
    const spec = planMounts(roles, live, configurable).specs[0]!
    expect(spec.config.persona).toBe('you implement')
    expect(spec.config.toolFilter).toEqual({ deny: ['subagent'] })
    expect(spec.config.agentOptions.maxTokens).toBe(4096)
  })

  it('omits maxTokens from agentOptions when the model does not set one', () => {
    const roles = [role({
      id: 'implementer',
      models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
    })]
    const spec = planMounts(roles, live, configurable).specs[0]!
    expect('maxTokens' in spec.config.agentOptions).toBe(false)
  })
})
