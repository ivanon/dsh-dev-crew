import type { Context } from '@deepseek-ai/cordis'
// 只为拉入 `Context.skills` 的模块增强声明；本文件不直接使用具名导出。
import type {} from '@deepseek-ai/dsh-skill'
import { SKILL_CONTENTS } from './content.generated.ts'

/** 一份内嵌 skill 的注册元数据。正文来自生成的 `SKILL_CONTENTS`。 */
interface CrewSkillMeta {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** 是否对模型可见。 */
  readonly modelInvocable: boolean
  /** 是否对人可见（作为命令）。 */
  readonly userInvocable: boolean
}

/**
 * 四份方法论的注册元数据。
 *
 * `crew-converge` 只对模型可见：它是流水线内部机制，人单独唤起没有意义。
 * 其余三份两个surface都开放，用户可以单独使用其中任何一份。
 */
const CREW_SKILLS: readonly CrewSkillMeta[] = [
  {
    name: 'crew-brainstorm',
    description: '把一个开发需求讨论成可实施的规格文档。',
    whenToUse: '需求模糊、需要先讨论清楚再动手时。',
    modelInvocable: true,
    userInvocable: true,
  },
  {
    name: 'crew-plan',
    description: '把一份规格文档拆成可逐任务执行的实施计划。',
    whenToUse: '已有规格、需要拆成可分派的任务时。',
    modelInvocable: true,
    userInvocable: true,
  },
  // `crew` 与 `crew-converge` 在 Task 6 随其正文一并加入。
]

/**
 * 注册四份内嵌方法论 skill。
 *
 * 用运行时内嵌注册而非文件系统 provider：dsh 的 skill 发现根都在用户侧
 * （项目目录与 home 目录），插件自带的目录不在其中；内嵌注册让正文随包分发，
 * 不依赖任何路径解析。
 * @param ctx - 注册 skill 的上下文。
 * @returns 取消全部注册的 disposer。
 */
export function registerCrewSkills(ctx: Context): () => void {
  const disposers = CREW_SKILLS.map(meta => {
    const content = SKILL_CONTENTS[meta.name]
    if (content === undefined) {
      throw new Error(`skill content missing for "${meta.name}"; run scripts/build-skills.mjs`)
    }
    return ctx.skills.register({
      name: meta.name,
      description: meta.description,
      ...meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse },
      content,
      // 'bundled'：正文随本插件分发，不是从用户侧目录发现的项目/用户 skill。
      source: 'bundled',
      invocation: { modelInvocable: meta.modelInvocable, userInvocable: meta.userInvocable },
    })
  })
  return () => { for (const dispose of disposers) dispose() }
}
