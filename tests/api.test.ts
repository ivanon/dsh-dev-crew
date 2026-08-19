import { afterEach, describe, expect, it, vi } from 'vitest'
import { callCrewApi } from '../src/client/api.ts'

describe('callCrewApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the parsed body on a successful JSON response', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { hello: 'world' } }), {
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchStub)

    const result = await callCrewApi<{ hello: string }>('health')

    expect(result).toEqual({ ok: true, value: { hello: 'world' } })
  })

  it('folds a fetch rejection (network down, host not started) into a NETWORK_ERROR result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))

    const result = await callCrewApi('health')

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NETWORK_ERROR')
    expect(result.error?.message).toContain('/crew/api/health')
    expect(result.error?.message).toContain('fetch failed')
  })

  it('folds a non-JSON response (e.g. an HTML fallback page) into an INVALID_RESPONSE result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))

    const result = await callCrewApi('settings.get', {})

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_RESPONSE')
    expect(result.error?.message).toContain('/crew/api/settings.get')
    expect(result.error?.message).toContain('200')
  })
})
