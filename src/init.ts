import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** 一次初始化的结果，区分本次创建与此前已存在。 */
export interface InitResult {
  /** 本次创建的目录，保持输入顺序。 */
  readonly created: string[]
  /** 此前已存在、本次跳过的目录。 */
  readonly skipped: string[]
}

/**
 * 创建流程产物目录。幂等：已存在的目录跳过，永不覆盖任何已有文件。
 *
 * 只创建目录，不写入任何文件，也不触碰用户的 agent 指令文件 —— 往 `AGENTS.md`
 * 追加内容等于单方面改写用户每个会话的系统提示词。目录约定写在插件自己的
 * skill 正文里。
 * @param dirs - 相对目录列表。
 * @param cwd - 解析基准。
 * @returns 创建与跳过的目录清单。
 */
export function initDirs(dirs: readonly string[], cwd: string): InitResult {
  const created: string[] = []
  const skipped: string[] = []
  for (const dir of dirs) {
    const absolute = resolve(cwd, dir)
    if (existsSync(absolute)) {
      skipped.push(dir)
      continue
    }
    mkdirSync(absolute, { recursive: true })
    created.push(dir)
  }
  return { created, skipped }
}
