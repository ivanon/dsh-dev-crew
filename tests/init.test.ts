import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initDirs } from '../src/init.ts'

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'crew-init-'))
}

const DIRS = ['docs/specs', 'docs/plans', 'docs/reports']

describe('initDirs', () => {
  it('creates every directory on a fresh project', () => {
    const root = freshRoot()
    const result = initDirs(DIRS, root)
    expect(result.created).toEqual(DIRS)
    expect(result.skipped).toEqual([])
    for (const dir of DIRS) expect(existsSync(join(root, dir))).toBe(true)
  })

  it('is idempotent: a second run creates nothing', () => {
    const root = freshRoot()
    initDirs(DIRS, root)
    const second = initDirs(DIRS, root)
    expect(second.created).toEqual([])
    expect(second.skipped).toEqual(DIRS)
  })

  it('never overwrites an existing file inside a target directory', () => {
    const root = freshRoot()
    mkdirSync(join(root, 'docs/plans'), { recursive: true })
    const existing = join(root, 'docs/plans', 'keep.md')
    writeFileSync(existing, 'original')
    initDirs(DIRS, root)
    expect(readFileSync(existing, 'utf8')).toBe('original')
  })

  it('reports partially existing directories correctly', () => {
    const root = freshRoot()
    mkdirSync(join(root, 'docs/plans'), { recursive: true })
    const result = initDirs(DIRS, root)
    expect(result.created).toEqual(['docs/specs', 'docs/reports'])
    expect(result.skipped).toEqual(['docs/plans'])
  })

  it('honors configured paths other than the defaults', () => {
    const root = freshRoot()
    const custom = ['documentation/design', '.spec']
    const result = initDirs(custom, root)
    expect(result.created).toEqual(custom)
    for (const dir of custom) expect(existsSync(join(root, dir))).toBe(true)
  })

  it('does not create an AGENTS.md or touch one that exists', () => {
    const root = freshRoot()
    const agents = join(root, 'AGENTS.md')
    writeFileSync(agents, 'user content')
    initDirs(DIRS, root)
    expect(readFileSync(agents, 'utf8')).toBe('user content')
  })
})
