/**
 * Tests for the settings API client (sgs-ui-wisp-las.1 Stage 2).
 *
 * Mock the BOUNDARY: global fetch. The client's URL construction, header
 * shape, body serialization, and response parsing all run against the mock
 * — we assert each is correct.
 *
 * Doctrine: build green ≠ feature works. Every test asserts the actual HTTP
 * call shape AND the parsed return value, not just "no exception."
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  deleteCredential,
  deleteEndpoint,
  getAppPref,
  getCredential,
  getEndpoint,
  listCredentials,
  listEndpoints,
  setAppPref,
  setCredential,
  setEndpoint,
  validateService,
} from './client'

type MockResponse = {
  status?: number
  body: BodyInit | null
  headers?: Record<string, string>
}

function mockFetch(responses: MockResponse[]) {
  const queue = [...responses]
  const fn: typeof fetch = async (..._args: Parameters<typeof fetch>) => {
    const next = queue.shift()
    if (!next) throw new Error('mockFetch: no more queued responses')
    return new Response(next.body, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  }
  return vi.fn<typeof fetch>(fn)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// === credentials ============================================================

describe('credentials', () => {
  test('listCredentials GETs the right URL and returns the names', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ credentials: ['runpod_api_key', 'r2_endpoint_url'] }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await listCredentials()

    expect(fetchMock).toHaveBeenCalledWith('/api/settings/credentials', expect.anything())
    expect(result).toEqual(['runpod_api_key', 'r2_endpoint_url'])
  })

  test('getCredential returns the value + updated_at on 200', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'runpod_api_key', value: 'rpa_x', updated_at: '2026-05-21T10:00:00+00:00' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const cred = await getCredential('runpod_api_key')

    expect(fetchMock).toHaveBeenCalledWith('/api/settings/credentials/runpod_api_key', expect.anything())
    expect(cred).toEqual({ name: 'runpod_api_key', value: 'rpa_x', updated_at: '2026-05-21T10:00:00+00:00' })
  })

  test('getCredential returns null on 404', async () => {
    const fetchMock = mockFetch([{ status: 404, body: JSON.stringify({ detail: 'not found' }) }])
    vi.stubGlobal('fetch', fetchMock)

    const cred = await getCredential('never_set')
    expect(cred).toBeNull()
  })

  test('setCredential PUTs with the right body shape', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ name: 'k', saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setCredential('runpod_api_key', 'rpa_new')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/credentials/runpod_api_key')
    expect(init.method).toBe('PUT')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ value: 'rpa_new' })
  })

  test('setCredential throws on non-2xx with the server-provided detail', async () => {
    const fetchMock = mockFetch([
      { status: 400, body: JSON.stringify({ detail: 'value is required' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(setCredential('k', '')).rejects.toThrow(/value is required/)
  })

  test('setCredential accepts empty string (distinct from unset)', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ name: 'k', saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setCredential('r2_secret', '')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ value: '' })
  })

  test('deleteCredential DELETEs the right URL', async () => {
    const fetchMock = mockFetch([{ status: 204, body: null }])
    vi.stubGlobal('fetch', fetchMock)

    await deleteCredential('topaz_api_key')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/credentials/topaz_api_key',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

// === endpoints ==============================================================

describe('endpoints', () => {
  test('listEndpoints returns the list of endpoint records', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          endpoints: [
            { type: 'aio_trainer', endpoint_id: 't1', volume_id: null, template_id: null, gpu_tier: null, volume_size_gb: null, max_workers: null, provisioned_at: null },
            { type: 'comfygen', endpoint_id: 'c1', volume_id: 'v1', template_id: null, gpu_tier: 'recommended', volume_size_gb: 200, max_workers: 3, provisioned_at: null },
          ],
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const list = await listEndpoints()
    expect(list).toHaveLength(2)
    expect(list[0].type).toBe('aio_trainer')
    expect(list[1].endpoint_id).toBe('c1')
  })

  test('getEndpoint returns the record on 200', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          type: 'comfygen',
          endpoint_id: 'ep_abc',
          volume_id: 'vol_xyz',
          template_id: 'tmpl_a',
          gpu_tier: 'budget',
          volume_size_gb: 100,
          max_workers: 2,
          provisioned_at: '2026-05-21T10:00:00Z',
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const ep = await getEndpoint('comfygen')
    expect(ep?.endpoint_id).toBe('ep_abc')
    expect(ep?.max_workers).toBe(2)
  })

  test('getEndpoint returns null on 404', async () => {
    const fetchMock = mockFetch([{ status: 404, body: JSON.stringify({ detail: 'not configured' }) }])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getEndpoint('comfygen')).toBeNull()
  })

  test('setEndpoint PUTs full body', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ type: 'comfygen' }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setEndpoint('comfygen', {
      endpoint_id: 'ep_new',
      volume_id: 'vol_new',
      gpu_tier: 'performance',
      volume_size_gb: 500,
      max_workers: 3,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/endpoints/comfygen')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body as string)
    expect(body.endpoint_id).toBe('ep_new')
    expect(body.gpu_tier).toBe('performance')
    expect(body.max_workers).toBe(3)
  })

  test('deleteEndpoint DELETEs the right URL', async () => {
    const fetchMock = mockFetch([{ status: 204, body: null }])
    vi.stubGlobal('fetch', fetchMock)

    await deleteEndpoint('aio_trainer')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/endpoints/aio_trainer',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

// === app-prefs ==============================================================

describe('app-prefs', () => {
  test('getAppPref returns value when set', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'output_dir', value: '/tmp/out' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAppPref('output_dir')).toBe('/tmp/out')
  })

  test('getAppPref returns null when unset', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'never_set', value: null }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAppPref('never_set')).toBeNull()
  })

  test('getAppPref passes default as query param when provided', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'k', value: 'default_val' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await getAppPref('k', 'default_val')

    const url = fetchMock.mock.calls[0][0]
    expect(url).toContain('default=default_val')
  })

  test('setAppPref PUTs with body { value }', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setAppPref('retention_days', '90')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/retention_days')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: '90' })
  })
})

// === validation =============================================================

describe('validateService', () => {
  test('returns {ok: true, info} on validator success', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ ok: true, error: null, info: { gpu_types_visible: 12 } }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateService('runpod')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/validate/runpod',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toEqual({ ok: true, error: null, info: { gpu_types_visible: 12 } })
  })

  test('returns {ok: false, error} when validator reports a failure', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ ok: false, error: 'HTTP 401', info: null }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateService('runpod')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('HTTP 401')
  })

  test('throws when prerequisite credentials are missing (400)', async () => {
    const fetchMock = mockFetch([
      { status: 400, body: JSON.stringify({ detail: 'runpod_api_key not configured' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(validateService('runpod')).rejects.toThrow(/runpod_api_key not configured/)
  })

  test('throws on 404 for unknown service', async () => {
    const fetchMock = mockFetch([
      { status: 404, body: JSON.stringify({ detail: 'no validator available for service: foo' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(validateService('foo')).rejects.toThrow(/no validator available/)
  })
})
