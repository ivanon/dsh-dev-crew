// 用裸的同步 node:fs，不是 ctx.fs：ToolGuard 的签名是同步的
// (`(execution) => string | undefined`)，而 ctx.fs 的方法是异步的（沙箱策略
// 需要跨越 IPC/网络等边界）。guard 无法 await，所以只能用同步 API 才能在
// 单次同步调用里做完这条判据要求的全部检查。这是已权衡接受的取舍：判据只做
// 本地只读的存在性与文件类型判断，不读取文件内容，绕过 ctx.fs 沙箱策略的
// 代价局限于此。不要把这里“修正”成 ctx.fs——改完要么编译不过（返回 Promise
// 而不是 string | undefined），要么被迫把检查改成 fire-and-forget、guard 永远
// 放行。
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** `resolvePlanPath` 的解析上下文。 */
export interface PlanPathOptions {
  /** 配置的 plans 目录，可以是相对路径。 */
  readonly plansDir: string
  /** 相对路径的解析基准。 */
  readonly cwd: string
}

/**
 * 匹配候选路径片段：非空白且含有路径分隔符或 `.md` 后缀的连续串。
 * 前后可被反引号、单双引号、圆括号包裹，捕获时不含包裹符。
 */
const CANDIDATE = /[`'"(]?([^\s`'"()]*[/\\][^\s`'"()]*|[^\s`'"()]+\.md)[`'")]?/g

/**
 * 从 prompt 中解析出一个位于 plans 目录之内、真实存在的普通文件路径。
 *
 * 五步：候选提取 → `resolve` 规范化 → 围栏前缀检查 → 存在性与文件类型 →
 * `realpath` 后重做围栏检查。最后一步不可省略：否则 plans 目录内的符号链接
 * 可以指向目录之外，绕过第三步。第二次围栏检查用 plans 目录自身的 realpath
 * （而不是第一次用的字面 `resolve` 结果）：plans 目录的祖先路径也可能经过
 * 符号链接（例如 macOS 的 `/var` → `/private/var`），若仍用字面前缀比较，
 * 会把候选自身的 realpath 误判为逃出围栏。
 * @param prompt - 委派工具收到的 prompt 参数。
 * @param options - plans 目录与相对路径基准。
 * @returns 第一个通过全部五步的绝对路径；没有则 `undefined`。
 */
export function resolvePlanPath(prompt: string, options: PlanPathOptions): string | undefined {
  const fence = resolve(options.plansDir) + sep
  let realFence: string
  try {
    realFence = realpathSync(resolve(options.plansDir)) + sep
  } catch {
    // plans 目录本身不存在或不可解析：任何候选都无法通过。
    return undefined
  }
  for (const match of prompt.matchAll(CANDIDATE)) {
    const candidate = match[1]
    if (candidate === undefined || candidate === '') continue
    const absolute = resolve(options.cwd, candidate)
    if (!absolute.startsWith(fence)) continue
    if (!existsSync(absolute)) continue
    let real: string
    try {
      real = realpathSync(absolute)
    } catch {
      // 竞态：候选在 existsSync 与 realpathSync 之间消失。视为不通过。
      continue
    }
    if (!real.startsWith(realFence)) continue
    if (!statSync(real).isFile()) continue
    // 返回 `absolute`（预 realpath 的字面路径），不是 `real`：调用方与测试
    // 都按字面路径比较，realpath 只用于围栏检查，不应改变返回值的形式。
    return absolute
  }
  return undefined
}

/** guard 注册所需的外部依赖。 */
export interface GateDeps {
  /** 当前挂载的 implementer 角色工具名；空集表示无需拦截。 */
  readonly implementerToolNames: () => readonly string[]
  /** 解析上下文。 */
  readonly options: () => PlanPathOptions
}

/** 拒绝理由：必须让模型知道怎么纠正，而不只是被拒。 */
const DENY_REASON
  = 'This implementer subagent must be given the path to a written plan file. '
  + 'Include the plan file path (inside the configured plans directory) in the prompt, '
  + 'and let the subagent read the file itself instead of pasting its contents here. '
  + 'If no plan exists yet, produce one first.'

/**
 * 注册纪律 guard：调用 implementer 角色工具时，prompt 中必须含一个可解析的
 * plan 文件路径。
 *
 * 用 `ctx.tools.guard()` 而非 `tools/pre-execute`：guard 是单调的，后续
 * waterfall 监听器无法把它的拒绝变回许可。这条判据不该被第三方插件覆盖。
 * @param ctx - 注册 guard 的上下文。
 * @param deps - 工具名集合与解析上下文的取值函数。
 * @returns 取消注册的 disposer。
 */
export function registerCrewGate(ctx: Context, deps: GateDeps): () => void {
  return ctx.tools.guard(execution => {
    const names = deps.implementerToolNames()
    if (!names.includes(execution.name)) return undefined
    const prompt = (execution.arguments as { prompt?: unknown }).prompt
    if (typeof prompt !== 'string') return DENY_REASON
    return resolvePlanPath(prompt, deps.options()) === undefined ? DENY_REASON : undefined
  })
}
