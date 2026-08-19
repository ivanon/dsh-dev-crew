import { describe, expect, it, vi } from 'vitest'
import { registerCrewSettings } from '../src/settings.ts'
import { BUILTIN_ROLES } from '../src/config.ts'

function fakeCtx(scope: unknown) {
  return {
    get: (name: string) => name === 'settings' ? { register: () => scope } : undefined,
  } as never
}

describe('registerCrewSettings', () => {
  it('is a no-op returning a disposer when no settings provider is composed', () => {
    const ctx = { get: () => undefined } as never
    const dispose = registerCrewSettings(ctx, { roles: BUILTIN_ROLES }, () => {})
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('pushes the initial resolved value to onChange', () => {
    const onChange = vi.fn()
    const value = { roles: BUILTIN_ROLES }
    const scope = { get: () => value, watch: () => () => {}, dispose: () => {} }
    registerCrewSettings(fakeCtx(scope), value, onChange)
    expect(onChange).toHaveBeenCalledWith(value)
  })

  it('forwards watched updates to onChange', () => {
    const onChange = vi.fn()
    let watcher: ((next: unknown) => void) | undefined
    const scope = {
      get: () => ({ roles: [] }),
      watch: (cb: (next: unknown) => void) => { watcher = cb; return () => {} },
      dispose: () => {},
    }
    registerCrewSettings(fakeCtx(scope), { roles: [] }, onChange)
    const next = { roles: BUILTIN_ROLES }
    watcher?.(next)
    expect(onChange).toHaveBeenLastCalledWith(next)
  })

  it('stops forwarding after dispose', () => {
    const onChange = vi.fn()
    let watcher: ((next: unknown) => void) | undefined
    const unwatch = vi.fn()
    const scope = {
      get: () => ({ roles: [] }),
      watch: (cb: (next: unknown) => void) => { watcher = cb; return unwatch },
      dispose: () => {},
    }
    const dispose = registerCrewSettings(fakeCtx(scope), { roles: [] }, onChange)
    dispose()
    expect(unwatch).toHaveBeenCalled()
  })
})
