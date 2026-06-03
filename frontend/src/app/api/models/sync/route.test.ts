import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

async function importRoute() {
  vi.resetModules()
  vi.stubEnv('BACKEND_PORT', '8123')
  return import('./route')
}

describe('/api/models/sync app route', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('forwards sync directly to the backend and preserves response status and content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ folders: ['loras'], models: [], stale: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const { POST } = await importRoute()

    const res = await POST(new Request('http://localhost/api/models/sync', { method: 'POST' }))

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8123/api/models/sync',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ folders: ['loras'], models: [], stale: false })
  })

  test('returns structured 500 json when the direct backend fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')))
    const { POST } = await importRoute()

    const res = await POST(new Request('http://localhost/api/models/sync', { method: 'POST' }))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Proxy error: socket hang up' })
  })
})
