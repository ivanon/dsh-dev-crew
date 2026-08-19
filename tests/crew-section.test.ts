import { describe, expect, it } from 'vitest'
import { displayHealth, isCustomProvider, providersInUse, withoutTemplateFields } from '../src/client/CrewSection.tsx'
import type { Config, CrewRole } from '../src/types.ts'

const role = (patch: Partial<CrewRole> = {}): CrewRole => ({
  id: 'implementer',
  enabled: true,
  models: [{ alias: 'default', provider: 'kimi-coding', model: 'k3' }],
  ...patch,
})

describe('displayHealth', () => {
  it('reports ready when the host mounted the tool', () => {
    const r = role()
    expect(displayHealth(r, r.models[0]!, ['subagent_implementer'], [])).toBe('ready')
  })

  it('reports disabled before consulting the host snapshot', () => {
    const r = role({ enabled: false })
    expect(displayHealth(r, r.models[0]!, ['subagent_implementer'], [])).toBe('disabled')
  })

  it('distinguishes unknown from missing when the host knows neither', () => {
    const r = role()
    // 宿主两份快照都不认识这个工具名：刚保存尚未重挂，或草稿尚未提交。
    // 断言成 missing（"不存在"）会把一个未知状态说成确定结论。
    expect(displayHealth(r, r.models[0]!, [], [])).toBe('unknown')
  })

  it('reports missing only when the host explicitly skipped the route', () => {
    const r = role()
    const skipped = [{ toolName: 'subagent_implementer', provider: 'kimi-coding', reason: 'missing' as const }]
    expect(displayHealth(r, r.models[0]!, [], skipped)).toBe('missing')
  })

  it('reports unconfigured when the host named that reason', () => {
    const r = role()
    const skipped = [{ toolName: 'subagent_implementer', provider: 'kimi-coding', reason: 'unconfigured' as const }]
    expect(displayHealth(r, r.models[0]!, [], skipped)).toBe('unconfigured')
  })

  it('uses the alias-suffixed tool name for multi-model roles', () => {
    const r = role({
      models: [
        { alias: 'ds', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { alias: 'kimi', provider: 'kimi-coding', model: 'k3' },
      ],
    })
    expect(displayHealth(r, r.models[0]!, ['subagent_implementer_ds'], [])).toBe('ready')
    expect(displayHealth(r, r.models[1]!, ['subagent_implementer_ds'], [])).toBe('unknown')
  })
})

describe('withoutTemplateFields', () => {
  const config = (): Config => ({
    roles: [
      role({ persona: 'filled from the builtin template', toolFilter: { deny: ['write'] } }),
      role({ id: 'reviewer', persona: 'another template body' }),
    ],
    pipeline: { maxConvergenceRounds: 5 },
    gate: { enabled: true, plansDir: 'docs/plans' },
    artifactDirs: ['docs/specs'],
  })

  it('drops persona and toolFilter from every role', () => {
    const result = withoutTemplateFields(config())
    for (const entry of result.roles) {
      expect(entry).not.toHaveProperty('persona')
      expect(entry).not.toHaveProperty('toolFilter')
    }
  })

  it('keeps every field the interface does edit', () => {
    const result = withoutTemplateFields(config())
    expect(result.roles.map(r => r.id)).toEqual(['implementer', 'reviewer'])
    expect(result.roles[0]!.enabled).toBe(true)
    expect(result.roles[0]!.models).toEqual([{ alias: 'default', provider: 'kimi-coding', model: 'k3' }])
  })

  it('leaves non-role sections untouched', () => {
    const source = config()
    const result = withoutTemplateFields(source)
    expect(result.pipeline).toEqual(source.pipeline)
    expect(result.gate).toEqual(source.gate)
    expect(result.artifactDirs).toEqual(source.artifactDirs)
  })

  it('does not mutate the draft it was given', () => {
    const source = config()
    withoutTemplateFields(source)
    expect(source.roles[0]).toHaveProperty('persona')
  })
})

describe('isCustomProvider', () => {
  const options = { live: ['kimi-coding'], configurable: ['deepseek-official'] }

  it('treats an empty value as "not selected", not custom', () => {
    expect(isCustomProvider('', options, false)).toBe(false)
  })

  it('accepts a live route as a dropdown selection', () => {
    expect(isCustomProvider('kimi-coding', options, false)).toBe(false)
  })

  it('accepts a configurable-but-inactive route as a dropdown selection', () => {
    expect(isCustomProvider('deepseek-official', options, false)).toBe(false)
  })

  it('falls back to free input for a route the host does not know', () => {
    // 从 cordis.patch.yml 配进来、或「先填后配」的路由都走这条。
    expect(isCustomProvider('qwen-not-yet-added', options, false)).toBe(true)
  })

  it('honours an explicit switch to custom even for a known route', () => {
    expect(isCustomProvider('kimi-coding', options, true)).toBe(true)
  })
})

describe('providersInUse', () => {
  it('collects distinct non-empty providers across roles and models', () => {
    const config: Config = {
      roles: [
        role({ models: [{ alias: 'a', provider: 'kimi-coding', model: 'k3' }] }),
        role({
          id: 'reviewer',
          models: [
            { alias: 'a', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            { alias: 'b', provider: 'kimi-coding', model: 'k3-256k' },
          ],
        }),
        role({ id: 'researcher', models: [{ alias: 'a', provider: '', model: '' }] }),
      ],
      pipeline: { maxConvergenceRounds: 5 },
      gate: { enabled: true, plansDir: 'docs/plans' },
      artifactDirs: [],
    }
    expect(providersInUse(config)).toEqual(['kimi-coding', 'deepseek-official'])
  })

  it('returns nothing when no provider is configured', () => {
    const config: Config = {
      roles: [role({ models: [{ alias: 'a', provider: '', model: '' }] })],
      pipeline: { maxConvergenceRounds: 5 },
      gate: { enabled: true, plansDir: 'docs/plans' },
      artifactDirs: [],
    }
    expect(providersInUse(config)).toEqual([])
  })
})
