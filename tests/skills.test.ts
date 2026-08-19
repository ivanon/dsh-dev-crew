import { describe, expect, it, vi } from 'vitest'
import { SKILL_CONTENTS } from '../src/skills/content.generated.ts'
import { registerCrewSkills } from '../src/skills/index.ts'

function fakeCtx() {
  const registered: { name: string; invocation: unknown; content: string }[] = []
  const disposers = vi.fn()
  return {
    registered,
    disposers,
    ctx: {
      skills: {
        register(skill: { name: string; invocation: unknown; content: string }) {
          registered.push(skill)
          return disposers
        },
      },
    } as never,
  }
}

describe('registerCrewSkills', () => {
  it('registers the crew skills declared so far', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    expect(registered.map(s => s.name)).toEqual(['crew', 'crew-brainstorm', 'crew-plan', 'crew-converge'])
  })

  it('exposes authoring skills on both surfaces', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    for (const name of ['crew-brainstorm', 'crew-plan']) {
      expect(registered.find(s => s.name === name)?.invocation)
        .toEqual({ modelInvocable: true, userInvocable: true })
    }
  })

  it('registers non-empty content for every skill', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    for (const skill of registered) expect(skill.content.length).toBeGreaterThan(200)
  })

  it('disposes every registration', () => {
    const { ctx, disposers } = fakeCtx()
    const dispose = registerCrewSkills(ctx)
    dispose()
    expect(disposers).toHaveBeenCalledTimes(4)
  })

  it('has generated content for every declared skill', () => {
    expect(Object.keys(SKILL_CONTENTS).sort()).toEqual(['crew', 'crew-brainstorm', 'crew-converge', 'crew-plan'])
  })

  it('keeps crew-converge invisible to human command surfaces', () => {
    const { ctx, registered } = fakeCtx()
    registerCrewSkills(ctx)
    expect(registered.find(s => s.name === 'crew-converge')?.invocation)
      .toEqual({ modelInvocable: true, userInvocable: false })
  })
})
