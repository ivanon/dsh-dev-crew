import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'src/skills'
const entries = readdirSync(dir).filter(file => file.endsWith('.md')).sort()

const body = entries
  .map(file => `  ${JSON.stringify(file.replace(/\.md$/, ''))}: ${JSON.stringify(readFileSync(join(dir, file), 'utf8'))},`)
  .join('\n')

writeFileSync(join(dir, 'content.generated.ts'), `// 由 scripts/build-skills.mjs 生成，请勿手改。编辑 src/skills/*.md 后重新运行。
/** 四份方法论正文，键为 skill 名。 */
export const SKILL_CONTENTS: Record<string, string> = {
${body}
}
`)

console.log(`generated ${entries.length} skill contents`)
