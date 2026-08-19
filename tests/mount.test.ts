import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES } from '../src/config.ts'
import { diffMounts, planMounts, specKey, toolNameFor } from '../src/mount.ts'
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

  describe('builtin template fill-in', () => {
    const builtinImplementer = BUILTIN_ROLES.find(entry => entry.id === 'implementer')!

    it('fills the builtin persona for a builtin id that supplies none', () => {
      const roles = [role({
        id: 'implementer',
        models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
      })]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect(spec.config.persona).toBe(builtinImplementer.persona)
    })

    it('keeps a user persona instead of the builtin one', () => {
      const roles = [role({
        id: 'implementer',
        persona: 'mine',
        models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
      })]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect(spec.config.persona).toBe('mine')
    })

    it('omits the persona key entirely for a non-builtin id that supplies none', () => {
      const roles = [role({
        id: 'custom',
        models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
      })]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect('persona' in spec.config).toBe(false)
      expect('toolFilter' in spec.config).toBe(false)
    })

    it('fills the builtin toolFilter for a builtin id that supplies none', () => {
      const roles = [role({
        id: 'implementer',
        models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
      })]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect(spec.config.toolFilter?.deny).toEqual(builtinImplementer.toolFilter!.deny)
    })

    it('replaces the builtin toolFilter wholesale when the user supplies one', () => {
      const roles = [role({
        id: 'reviewer',
        toolFilter: { allow: ['read'] },
        models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }],
      })]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect(spec.config.toolFilter).toEqual({ allow: ['read'] })
    })
  })

  describe('mutual crew-tool deny', () => {
    it('denies every other mounted crew tool but not the instance itself', () => {
      const roles = [
        role({ id: 'implementer', models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }] }),
        role({ id: 'reviewer', models: [{ alias: 'default', provider: 'kimi-coding', model: 'k3' }] }),
      ]
      const [implementer, reviewer] = planMounts(roles, live, configurable).specs
      expect(implementer!.config.toolFilter!.deny).toContain('subagent_reviewer')
      expect(implementer!.config.toolFilter!.deny).not.toContain('subagent_implementer')
      expect(reviewer!.config.toolFilter!.deny).toContain('subagent_implementer')
      expect(reviewer!.config.toolFilter!.deny).not.toContain('subagent_reviewer')
    })

    it('keeps the role deny entries ahead of the injected crew names, deduplicated', () => {
      const roles = [
        role({ id: 'implementer', models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }] }),
        role({ id: 'reviewer', models: [{ alias: 'default', provider: 'kimi-coding', model: 'k3' }] }),
      ]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect(spec.config.toolFilter!.deny)
        .toEqual([...BUILTIN_ROLES.find(entry => entry.id === 'implementer')!.toolFilter!.deny!, 'subagent_reviewer'])
    })

    it('creates a toolFilter for a role that has none when another crew tool mounts', () => {
      const roles = [
        role({ id: 'custom', models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }] }),
        role({ id: 'other', models: [{ alias: 'default', provider: 'kimi-coding', model: 'k3' }] }),
      ]
      const spec = planMounts(roles, live, configurable).specs[0]!
      expect(spec.config.toolFilter).toEqual({ deny: ['subagent_other'] })
    })

    it('never denies a tool name that was skipped, since restrict rejects unregistered names', () => {
      const roles = [
        role({ id: 'implementer', models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }] }),
        role({ id: 'researcher', models: [{ alias: 'default', provider: 'qwen', model: 'Qwen3' }] }),
      ]
      const plan = planMounts(roles, live, configurable)
      expect(plan.skipped.map(entry => entry.toolName)).toEqual(['subagent_researcher'])
      expect(plan.specs[0]!.config.toolFilter!.deny).not.toContain('subagent_researcher')
    })
  })

  describe('duplicate tool names', () => {
    it('throws when two enabled roles share an id', () => {
      const roles = [
        role({ id: 'reviewer', models: [{ alias: 'default', provider: 'deepseek-official', model: 'm' }] }),
        role({ id: 'reviewer', models: [{ alias: 'default', provider: 'kimi-coding', model: 'k3' }] }),
      ]
      expect(() => planMounts(roles, live, configurable))
        .toThrow(/role "reviewer" alias "default".*subagent_reviewer/s)
    })

    it('throws when one role repeats an alias', () => {
      const roles = [role({
        id: 'reviewer',
        models: [
          { alias: 'ds', provider: 'deepseek-official', model: 'm' },
          { alias: 'ds', provider: 'kimi-coding', model: 'k3' },
        ],
      })]
      expect(() => planMounts(roles, live, configurable))
        .toThrow(/alias "ds".*subagent_reviewer_ds/s)
    })

    it('throws even when the colliding routes are not ready to mount', () => {
      const roles = [
        role({ id: 'solo', models: [{ alias: 'default', provider: 'nope', model: 'm' }] }),
        role({ id: 'solo', models: [{ alias: 'default', provider: 'nope', model: 'm' }] }),
      ]
      expect(() => planMounts(roles, live, configurable)).toThrow(/subagent_solo/)
    })
  })
})

describe('diffMounts', () => {
  const specA = {
    toolName: 'subagent_a',
    config: {
      provider: 'spawn' as const,
      toolName: 'subagent_a',
      backgroundMode: 'continuable' as const,
      agentOptions: { provider: 'p', model: 'm' },
    },
  }
  const specB = { ...specA, toolName: 'subagent_b', config: { ...specA.config, toolName: 'subagent_b' } }

  it('adds a spec that is not currently mounted', () => {
    expect(diffMounts([], [specA])).toEqual({ toAdd: [specA], toRemove: [] })
  })

  it('removes a mounted spec that is no longer planned', () => {
    expect(diffMounts([specA], [])).toEqual({ toAdd: [], toRemove: ['subagent_a'] })
  })

  it('does nothing when the plan is unchanged', () => {
    expect(diffMounts([specA], [specA])).toEqual({ toAdd: [], toRemove: [] })
  })

  it('remounts a spec whose config changed under the same tool name', () => {
    const changed = { ...specA, config: { ...specA.config, agentOptions: { provider: 'p', model: 'other' } } }
    expect(diffMounts([specA], [changed]))
      .toEqual({ toAdd: [changed], toRemove: ['subagent_a'] })
  })

  it('handles simultaneous add and remove', () => {
    expect(diffMounts([specA], [specB])).toEqual({ toAdd: [specB], toRemove: ['subagent_a'] })
  })
})

describe('specKey', () => {
  const base = {
    toolName: 'subagent_a',
    config: {
      provider: 'spawn' as const,
      toolName: 'subagent_a',
      backgroundMode: 'continuable' as const,
      agentOptions: { provider: 'p', model: 'm' },
      persona: 'you implement',
      toolFilter: { deny: ['subagent'] },
    },
  }

  it('is stable across differently ordered but semantically identical configs', () => {
    const reordered = {
      toolName: 'subagent_a',
      config: {
        toolFilter: { deny: ['subagent'] },
        persona: 'you implement',
        agentOptions: { model: 'm', provider: 'p' },
        backgroundMode: 'continuable' as const,
        toolName: 'subagent_a',
        provider: 'spawn' as const,
      },
    }
    expect(specKey(reordered)).toBe(specKey(base))
  })

  it('changes when the model changes', () => {
    const changed = { ...base, config: { ...base.config, agentOptions: { provider: 'p', model: 'other' } } }
    expect(specKey(changed)).not.toBe(specKey(base))
  })

  it('changes when the deny list content changes', () => {
    const changed = { ...base, config: { ...base.config, toolFilter: { deny: ['other'] } } }
    expect(specKey(changed)).not.toBe(specKey(base))
  })

  it('is stable across deny lists that differ only in order', () => {
    const a = { ...base, config: { ...base.config, toolFilter: { deny: ['x', 'y'] } } }
    const b = { ...base, config: { ...base.config, toolFilter: { deny: ['y', 'x'] } } }
    expect(specKey(a)).toBe(specKey(b))
  })

  it('distinguishes an absent persona from an empty one', () => {
    const withoutPersona = { toolName: 'subagent_a', config: { ...base.config } }
    delete (withoutPersona.config as { persona?: string }).persona
    const emptyPersona = { ...base, config: { ...base.config, persona: '' } }
    expect(specKey(withoutPersona)).not.toBe(specKey(emptyPersona))
  })
})
