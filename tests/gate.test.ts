import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { registerCrewGate, resolvePlanPath } from '../src/gate.ts'

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

/** 记录 guard 回调的 tools 替身。 */
function fakeToolsCtx() {
  let guard: ((execution: { name: string; arguments: unknown }) => string | undefined) | undefined
  return {
    call: (name: string, args: unknown) => guard?.({ name, arguments: args }),
    ctx: { tools: { guard: (fn: typeof guard) => { guard = fn; return () => {} } } } as never,
  }
}

describe('registerCrewGate', () => {
  const deps = (names: string[]) => ({
    implementerToolNames: () => names,
    options: () => ({ plansDir, cwd: root }),
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
