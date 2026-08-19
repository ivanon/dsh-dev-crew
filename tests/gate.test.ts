import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { planFence, registerCrewGate, resolvePlanPath } from '../src/gate.ts'

let root: string
let plansDir: string
let planFile: string
let outsideFile: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-gate-'))
  plansDir = join(root, 'docs', 'plans')
  mkdirSync(plansDir, { recursive: true })
  planFile = join(plansDir, '2026-08-19-feature.md')
  writeFileSync(planFile, '# plan')
  outsideFile = join(root, 'secret.md')
  writeFileSync(outsideFile, 'secret')
  symlinkSync(outsideFile, join(plansDir, 'escape.md'))
  mkdirSync(join(plansDir, 'subdir'))
})

const opts = () => ({ plansDir, cwd: root })

describe('resolvePlanPath', () => {
  it('accepts an absolute path inside the plans directory', () => {
    expect(resolvePlanPath(`按 ${planFile} 实现第 3 个任务`, opts())).toBe(planFile)
  })

  it('accepts a relative path resolved against cwd', () => {
    expect(resolvePlanPath('按 docs/plans/2026-08-19-feature.md 实现', opts())).toBe(planFile)
  })

  it('accepts a path wrapped in backticks', () => {
    expect(resolvePlanPath('按 `docs/plans/2026-08-19-feature.md` 实现', opts())).toBe(planFile)
  })

  it('accepts a path wrapped in double quotes', () => {
    expect(resolvePlanPath('read "docs/plans/2026-08-19-feature.md" first', opts())).toBe(planFile)
  })

  it('rejects a prompt with no path at all', () => {
    expect(resolvePlanPath('实现登录功能，写好测试', opts())).toBeUndefined()
  })

  it('rejects a path that does not exist', () => {
    expect(resolvePlanPath('按 docs/plans/nonexistent.md 实现', opts())).toBeUndefined()
  })

  it('rejects a path outside the plans directory', () => {
    expect(resolvePlanPath(`按 ${outsideFile} 实现`, opts())).toBeUndefined()
  })

  it('rejects traversal escaping the plans directory', () => {
    expect(resolvePlanPath('按 docs/plans/../secret.md 实现', opts())).toBeUndefined()
  })

  it('rejects a symlink pointing outside the plans directory', () => {
    // 围栏检查在 realpath 之后重做一次，否则符号链接可以绕过第一次检查。
    expect(resolvePlanPath('按 docs/plans/escape.md 实现', opts())).toBeUndefined()
  })

  it('rejects a directory even when it is inside the plans directory', () => {
    expect(resolvePlanPath('按 docs/plans/subdir 实现', opts())).toBeUndefined()
  })

  it('returns the first valid path when several are present', () => {
    const prompt = `参考 docs/plans/nonexistent.md 与 ${planFile}`
    expect(resolvePlanPath(prompt, opts())).toBe(planFile)
  })

  // 2026-08-19 真实客户端联调复现：协调者模型用自然中文转述路径时，若路径紧邻
  // 全角标点（冒号、括号、逗号等），旧的 CANDIDATE 正则会把标点一并吞进候选串，
  // 导致一个真实存在、合法落在 plansDir 内的路径被误判为不通过围栏检查而拒绝。
  it('accepts a relative path immediately wrapped in full-width parentheses', () => {
    expect(resolvePlanPath('按（docs/plans/2026-08-19-feature.md）实现', opts())).toBe(planFile)
  })

  it('accepts a relative path immediately preceded by a full-width colon', () => {
    expect(resolvePlanPath('计划文件：docs/plans/2026-08-19-feature.md', opts())).toBe(planFile)
  })

  it('accepts a relative path immediately followed by a full-width comma', () => {
    expect(resolvePlanPath('参考 docs/plans/2026-08-19-feature.md，然后动手', opts())).toBe(planFile)
  })

  it('accepts an absolute path surrounded by full-width colon and full-width period', () => {
    expect(resolvePlanPath(`计划文件：${planFile}。请照做`, opts())).toBe(planFile)
  })

  // 反向用例：排除全角标点不能顺带放宽围栏本身——穿越与符号链接逃逸即便紧邻
  // 全角标点也必须继续被拒绝。
  it('still rejects traversal escaping the plans directory when wrapped in full-width parentheses', () => {
    expect(resolvePlanPath('按（docs/plans/../secret.md）实现', opts())).toBeUndefined()
  })

  it('still rejects a symlink pointing outside the plans directory when wrapped in full-width parentheses', () => {
    expect(resolvePlanPath('按（docs/plans/escape.md）实现', opts())).toBeUndefined()
  })

  it('still rejects a path outside the plans directory when immediately preceded by a full-width colon', () => {
    expect(resolvePlanPath(`计划文件：${outsideFile}`, opts())).toBeUndefined()
  })
})

/**
 * 记录 guard 回调的 tools 替身。
 *
 * `call` 的第三个参数模拟宿主注入的会话工作目录（`execution.agent.session.header.cwd`）；
 * 省略它模拟没有 agent 的执行路径，此时 guard 应回退到 `fallbackCwd`。
 */
function fakeToolsCtx() {
  interface FakeExecution {
    name: string
    arguments: unknown
    agent?: { session: { header: { cwd?: string } } }
  }
  let guard: ((execution: FakeExecution) => string | undefined) | undefined
  return {
    call: (name: string, args: unknown, sessionCwd?: string) => guard?.({
      name,
      arguments: args,
      ...sessionCwd === undefined ? {} : { agent: { session: { header: { cwd: sessionCwd } } } },
    }),
    ctx: { tools: { guard: (fn: typeof guard) => { guard = fn; return () => {} } } } as never,
  }
}

describe('registerCrewGate', () => {
  const deps = (names: string[], fallback = root) => ({
    implementerToolNames: () => names,
    plansDir: () => plansDir,
    fallbackCwd: () => fallback,
  })

  it('denies an implementer call whose prompt carries no plan path', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps(['subagent_implementer']))
    expect(call('subagent_implementer', { prompt: '实现登录功能' })).toContain('plan')
  })

  it('allows an implementer call with a valid plan path', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps(['subagent_implementer']))
    expect(call('subagent_implementer', { prompt: `按 ${planFile} 实现` })).toBeUndefined()
  })

  it('denies an implementer call whose prompt is not a string', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps(['subagent_implementer']))
    expect(call('subagent_implementer', { prompt: 42 })).toContain('plan')
  })

  it('leaves non-implementer tools alone even without a plan path', () => {
    // reviewer 不该被这条判据拦截：它评审产物，不实现计划。
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps(['subagent_implementer']))
    expect(call('subagent_reviewer_ds', { prompt: '评审这份规格' })).toBeUndefined()
  })

  it('leaves every tool alone when no implementer tool is mounted', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps([]))
    expect(call('subagent_implementer', { prompt: '无路径' })).toBeUndefined()
  })
})

describe('fence basis', () => {
  // 真实配置里 gate.plansDir 的默认值是相对路径 'docs/plans'，而本文件其余用例
  // 都传绝对路径——绝对路径下 resolve 忽略基准，正是这一点让 issue #6 的基准
  // 错位从未被测出。以下用例一律用相对 plansDir。
  const RELATIVE = join('docs', 'plans')

  it('resolves a relative plansDir against options.cwd, not process.cwd()', () => {
    expect(planFence({ plansDir: RELATIVE, cwd: root })).toBe(plansDir)
  })

  it('does not let process.cwd() leak into the fence', () => {
    expect(process.cwd()).not.toBe(root)
    expect(planFence({ plansDir: RELATIVE, cwd: root })).not.toContain(process.cwd())
  })

  it('accepts a plan path under options.cwd while process.cwd() differs', () => {
    expect(resolvePlanPath(`按 ${planFile} 实现`, { plansDir: RELATIVE, cwd: root })).toBe(planFile)
  })

  it('rejects a path under process.cwd() when options.cwd points elsewhere', () => {
    // 反向：围栏跟随 options.cwd，所以 process.cwd() 下的同名相对路径不该通过。
    expect(resolvePlanPath('docs/plans/2026-08-19-feature.md', { plansDir: RELATIVE, cwd: tmpdir() }))
      .toBeUndefined()
  })
})

describe('gate diagnostics', () => {
  const RELATIVE = join('docs', 'plans')
  const deps2 = (names: string[], fallback: string) => ({
    implementerToolNames: () => names,
    plansDir: () => RELATIVE,
    fallbackCwd: () => fallback,
  })

  it('takes the fence basis from the session working directory', () => {
    const { call, ctx } = fakeToolsCtx()
    // fallbackCwd 指向无关目录：只有读到会话 cwd 才可能放行。
    registerCrewGate(ctx, deps2(['subagent_implementer'], tmpdir()))
    expect(call('subagent_implementer', { prompt: `按 ${planFile} 实现` }, root)).toBeUndefined()
  })

  it('falls back to fallbackCwd when the session carries no cwd', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps2(['subagent_implementer'], root))
    expect(call('subagent_implementer', { prompt: `按 ${planFile} 实现` })).toBeUndefined()
  })

  it('denies when the session cwd points away from the plan file', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps2(['subagent_implementer'], root))
    // 这是 issue #6 的现场：路径真实存在，但会话工作目录使围栏落在别处。
    expect(call('subagent_implementer', { prompt: `按 ${planFile} 实现` }, tmpdir())).toContain('plan')
  })

  it('names the resolved fence in the denial so a misconfiguration is diagnosable', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps2(['subagent_implementer'], root))
    expect(call('subagent_implementer', { prompt: '实现登录功能' })).toContain(plansDir)
  })

  it('says which basis produced the fence', () => {
    const { call, ctx } = fakeToolsCtx()
    registerCrewGate(ctx, deps2(['subagent_implementer'], root))
    expect(call('subagent_implementer', { prompt: 'no path' }, root)).toContain('session')
    expect(call('subagent_implementer', { prompt: 'no path' })).toContain('host process')
  })
})
