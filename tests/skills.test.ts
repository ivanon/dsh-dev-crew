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

describe('tool field names quoted in skill bodies', () => {
  const body = (name: string): string => {
    const found = SKILL_CONTENTS[name]
    if (found === undefined) throw new Error(`no skill content for "${name}"`)
    return found
  }

  it('spells ask_user_question multi-select with an underscore', () => {
    // 宿主的 schema 字段是 `multi_select`（tool-ask-user 里唯一的 snake_case），
    // 而 additionalProperties: true 让拼成 `multiSelect` 既不报错也不生效——题目
    // 静默退化成单选。真实会话里主 agent 照着写错的示例传了 multiSelect: true，
    // 问题文本写着「（多选）」，界面却只能选一个。
    //
    // 只查 JSON 示例块：正文里那句「写成 multiSelect 会被静默忽略」是警示，
    // 必须保留。
    const block = /```json\n([\s\S]*?)```/.exec(body('crew-brainstorm'))?.[1] ?? ''
    expect(block).toContain('multi_select')
    expect(block).not.toMatch(/multiSelect/)
  })

  it('quotes only field names the host actually accepts', () => {
    // 逐字抄自 packages/interaction/tool-ask-user/src/index.ts 的 parameters。
    const accepted = ['id', 'question', 'header', 'options', 'label', 'description', 'multi_select']
    const text = body('crew-brainstorm')
    // 从示例 JSON 里取出所有被引号包起来的键，逐个核对。
    const block = /```json\n([\s\S]*?)```/.exec(text)?.[1] ?? ''
    const keys = [...block.matchAll(/"([a-zA-Z_]+)":/g)].map(m => m[1]!)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      if (key === 'questions') continue
      expect(accepted, `示例里的 "${key}" 不是宿主接受的字段`).toContain(key)
    }
  })
})
