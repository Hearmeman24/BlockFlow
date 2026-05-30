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
  getInstalledPreset,
  getPresetManifest,
  listInstalledPresets,
  wizardAttach,
  wizardHealth,
  wizardPreflight,
  wizardProvision,
  wizardTeardown,
  wizardTiers,
  installPreset,
  InstallRefusedError,
  getAssetStorageMode,
  setAssetStorageMode,
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

  test('getAssetStorageMode defaults to tmpfiles when unset', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: null }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAssetStorageMode()).toBe('tmpfiles')
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/app-prefs/asset_storage_mode', expect.anything())
  })

  test('getAssetStorageMode returns stored valid mode', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: 'r2_signed' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAssetStorageMode()).toBe('r2_signed')
  })

  test('getAssetStorageMode falls back to tmpfiles for invalid stored mode', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: 'public_forever' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAssetStorageMode()).toBe('tmpfiles')
  })

  test('setAssetStorageMode persists only supported modes', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setAssetStorageMode('local_only')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/asset_storage_mode')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: 'local_only' })
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

// === wizard =================================================================

describe('wizardPreflight', () => {
  test('returns {ready, missing} on success', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ ready: false, missing: ['runpod_api_key', 'r2_bucket'] }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardPreflight()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/wizard/comfygen/preflight',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toMatchObject({ ready: false, missing: ['runpod_api_key', 'r2_bucket'] })
    // sgs-ui-5nn: services map defaults to {} when older backend omits it.
    expect(result.services).toEqual({})
  })

  test('returns {ready: true, missing: []} when all creds present', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ ready: true, missing: [] }) }])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardPreflight()
    expect(result.ready).toBe(true)
    expect(result.missing).toEqual([])
  })
})

describe('wizardTiers', () => {
  test('returns the list of tiers in canonical order', async () => {
    const tiers = [
      { id: 'budget', name: 'Budget', gpu_ids: ['NVIDIA GeForce RTX 5090'], datacenter: 'EU-RO-1', label: 'RTX 5090 (32GB)', region: 'Europe — Romania' },
      { id: 'recommended', name: 'Recommended', gpu_ids: ['NVIDIA RTX PRO 6000 Blackwell Server Edition'], datacenter: 'EUR-IS-1', label: 'RTX PRO 6000', region: 'Europe — Iceland' },
      { id: 'performance', name: 'Performance', gpu_ids: ['NVIDIA H100 NVL'], datacenter: 'US-KS-2', label: 'H100', region: 'US — Kansas' },
    ]
    const fetchMock = mockFetch([{ body: JSON.stringify({ tiers }) }])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardTiers()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/wizard/comfygen/tiers',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.map((t) => t.id)).toEqual(['budget', 'recommended', 'performance'])
    expect(result[0].gpu_ids).toEqual(['NVIDIA GeForce RTX 5090'])
  })
})

describe('wizardProvision', () => {
  test('POSTs the input + returns the provisioning result', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          endpoint_id: 'ep_x',
          template_id: 'tmpl_x',
          template_name: 'blockflow-comfygen-x-template-x',
          volume_id: 'vol_x',
          name: 'blockflow-comfygen-x',
          tier: 'budget',
          status: 'provisioning',
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardProvision({ tier: 'budget', volume_size_gb: 200, max_workers: 3 })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/wizard/comfygen/provision')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      tier: 'budget',
      volume_size_gb: 200,
      max_workers: 3,
    })
    expect(result.endpoint_id).toBe('ep_x')
    expect(result.template_name).toBe('blockflow-comfygen-x-template-x')
    expect(result.status).toBe('provisioning')
  })

  test('omits undefined fields from the body', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          endpoint_id: 'ep_y', template_id: 't', template_name: 'n', volume_id: 'v',
          name: 'n', tier: 'budget', status: 'provisioning',
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await wizardProvision({ tier: 'budget' })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ tier: 'budget' })
    expect('volume_size_gb' in body).toBe(false)
    expect('max_workers' in body).toBe(false)
  })

  test('throws when backend returns 400 (e.g. missing creds)', async () => {
    const fetchMock = mockFetch([
      { status: 400, body: JSON.stringify({ detail: "missing required credentials in Settings: ['runpod_api_key']" }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(wizardProvision({ tier: 'budget' })).rejects.toThrow(/runpod_api_key/)
  })

  test('throws when backend returns 500 (provisioning failed)', async () => {
    const fetchMock = mockFetch([
      { status: 500, body: JSON.stringify({ detail: 'RunPod error: quota exceeded' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(wizardProvision({ tier: 'budget' })).rejects.toThrow(/quota/)
  })
})

describe('wizardAttach', () => {
  test('POSTs endpoint_id + optional volume_id', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          type: 'comfygen', endpoint_id: 'ep_existing', volume_id: 'vol_existing',
          template_id: null, template_name: null, gpu_tier: null,
          volume_size_gb: null, max_workers: null, provisioned_at: null,
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardAttach('ep_existing', 'vol_existing')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/wizard/comfygen/attach')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint_id: 'ep_existing',
      volume_id: 'vol_existing',
    })
    expect(result.endpoint_id).toBe('ep_existing')
  })

  test('omits volume_id when not provided', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ type: 'comfygen', endpoint_id: 'ep_x', volume_id: null, template_id: null, gpu_tier: null, volume_size_gb: null, max_workers: null, provisioned_at: null }) }])
    vi.stubGlobal('fetch', fetchMock)

    await wizardAttach('ep_x')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ endpoint_id: 'ep_x' })
  })

  test('throws when the attach validation fails (400)', async () => {
    const fetchMock = mockFetch([
      { status: 400, body: JSON.stringify({ detail: 'could not reach endpoint ep_bad: HTTP 404' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(wizardAttach('ep_bad')).rejects.toThrow(/could not reach/)
  })
})

describe('wizardHealth', () => {
  test('returns the worker counts on 200', async () => {
    const workers = { ready: 1, idle: 0, running: 0, throttled: 0, initializing: 0 }
    const fetchMock = mockFetch([{ body: JSON.stringify({ workers }) }])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardHealth('ep_abc')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/wizard/comfygen/health/ep_abc',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual({ workers })
  })

  test('throws on upstream RunPod error (502)', async () => {
    const fetchMock = mockFetch([
      { status: 502, body: JSON.stringify({ detail: 'upstream RunPod error: network error: timeout' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(wizardHealth('ep_x')).rejects.toThrow(/upstream/)
  })
})

describe('wizardTeardown', () => {
  test('POSTs + returns the teardown result', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          ok: true,
          deleted: { endpoint_id: 'ep_x', template_name: 't', volume_id: 'v' },
          successes: ['drain', 'endpoint', 'template', 'volume'],
          warnings: [],
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardTeardown()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/wizard/comfygen/teardown',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.ok).toBe(true)
    expect(result.successes).toEqual(['drain', 'endpoint', 'template', 'volume'])
  })

  test('throws on 404 when no endpoint configured', async () => {
    const fetchMock = mockFetch([
      { status: 404, body: JSON.stringify({ detail: 'no ComfyGen endpoint configured to tear down' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(wizardTeardown()).rejects.toThrow(/no ComfyGen endpoint/)
  })

  test('returns warnings on partial RunPod failure (200)', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          ok: true,
          deleted: { endpoint_id: 'ep_x', template_name: null, volume_id: 'v' },
          successes: ['endpoint', 'volume'],
          warnings: ['no template_name in Settings'],
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await wizardTeardown()
    expect(result.warnings).toContain('no template_name in Settings')
  })
})

// === presets (Stage A) ======================================================

describe('getPresetManifest', () => {
  test('GETs the manifest endpoint + returns parsed body', async () => {
    const manifest = {
      manifest_version: 1,
      presets: [
        {
          id: 'qwen-image-lighting',
          name: 'Qwen Image Lighting',
          comfygen_min_version: '0.2.0',
          disk_size_estimate_gb: 65,
          preset_url: 'https://example/preset.json',
        },
      ],
    }
    const fetchMock = mockFetch([{ body: JSON.stringify(manifest) }])
    vi.stubGlobal('fetch', fetchMock)

    const result = await getPresetManifest()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/presets/manifest',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.presets).toHaveLength(1)
    expect(result.presets[0].id).toBe('qwen-image-lighting')
  })

  test('appends ?refresh=1 when refresh:true', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ manifest_version: 1, presets: [] }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await getPresetManifest({ refresh: true })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/presets/manifest?refresh=1')
  })

  test('returns the stale-cache flag + fetch_error when the backend falls back', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          manifest_version: 1,
          presets: [],
          cache: 'stale',
          fetch_error: 'network unreachable',
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await getPresetManifest()
    expect(result.cache).toBe('stale')
    expect(result.fetch_error).toBe('network unreachable')
  })

  test('throws on 502 (no cache + unreachable)', async () => {
    const fetchMock = mockFetch([
      { status: 502, body: JSON.stringify({ detail: 'could not reach preset registry' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(getPresetManifest()).rejects.toThrow(/could not reach/)
  })
})

describe('listInstalledPresets', () => {
  test('returns array of installed summaries', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          installed: [
            {
              preset_id: 'qwen-image-lighting',
              version: '0.2.0',
              disk_size_gb: 65,
              installed_at: '2026-05-21T10:00:00',
              updated_at: '2026-05-21T10:00:00',
            },
          ],
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await listInstalledPresets()
    expect(result).toHaveLength(1)
    expect(result[0].preset_id).toBe('qwen-image-lighting')
    expect(result[0].disk_size_gb).toBe(65)
  })

  test('returns [] when nothing installed', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ installed: [] }) }])
    vi.stubGlobal('fetch', fetchMock)

    expect(await listInstalledPresets()).toEqual([])
  })
})

describe('getInstalledPreset', () => {
  test('returns the preset detail with workflow_json parsed', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          preset_id: 'qwen-image-lighting',
          version: '0.2.0',
          disk_size_gb: 65,
          installed_at: '2026-05-21T10:00:00',
          updated_at: '2026-05-21T10:00:00',
          workflow_json: { '3': { class_type: 'KSampler' } },
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await getInstalledPreset('qwen-image-lighting')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/presets/installed/qwen-image-lighting',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.workflow_json).toEqual({ '3': { class_type: 'KSampler' } })
  })

  test('throws on 404 when not installed', async () => {
    const fetchMock = mockFetch([
      { status: 404, body: JSON.stringify({ detail: "preset 'foo' is not installed" }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(getInstalledPreset('foo')).rejects.toThrow(/not installed/)
  })

  // sgs-ui-fmy
  test('returns recommendations field when present', async () => {
    const fetchMock = mockFetch([
      {
        body: JSON.stringify({
          preset_id: 'wan-animate',
          version: '0.1.0',
          disk_size_gb: 30,
          installed_at: '2026-05-21T10:00:00',
          updated_at: '2026-05-21T10:00:00',
          workflow_json: [
            { name: 'Replace Face', json: { '3': { class_type: 'WanAnimate' } } },
          ],
          recommendations: {
            global: ['Pairs best with a character LoRA'],
            workflows: {
              'Replace Face': ['Bump mask coverage for tight crops'],
            },
          },
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await getInstalledPreset('wan-animate')
    expect(result.recommendations).toEqual({
      global: ['Pairs best with a character LoRA'],
      workflows: { 'Replace Face': ['Bump mask coverage for tight crops'] },
    })
  })
})

describe('installPreset (sgs-ui-41c structured refusal)', () => {
  test('throws InstallRefusedError on 400 with missing_credential detail', async () => {
    const fetchMock = mockFetch([{
      status: 400,
      body: JSON.stringify({
        detail: {
          error_kind: 'missing_credential',
          credential: 'civitai_api_key',
          preset_id: 'civitai-pack',
          reason: 'This preset downloads from CivitAI which requires authentication.',
        },
      }),
    }])
    vi.stubGlobal('fetch', fetchMock)

    await expect(installPreset('civitai-pack')).rejects.toMatchObject({
      name: 'InstallRefusedError',
      credential: 'civitai_api_key',
      presetId: 'civitai-pack',
    })
  })

  test('InstallRefusedError carries the human-readable reason on .message', async () => {
    const fetchMock = mockFetch([{
      status: 400,
      body: JSON.stringify({
        detail: {
          error_kind: 'missing_credential',
          credential: 'civitai_api_key',
          preset_id: 'p',
          reason: 'GO SET THE TOKEN',
        },
      }),
    }])
    vi.stubGlobal('fetch', fetchMock)

    try {
      await installPreset('p')
      throw new Error('expected InstallRefusedError')
    } catch (err) {
      expect(err).toBeInstanceOf(InstallRefusedError)
      expect((err as Error).message).toBe('GO SET THE TOKEN')
    }
  })

  test('non-structured 400 still surfaces as a regular Error', async () => {
    const fetchMock = mockFetch([{
      status: 400,
      body: JSON.stringify({ detail: 'plain string error' }),
    }])
    vi.stubGlobal('fetch', fetchMock)

    await expect(installPreset('x')).rejects.toThrow('plain string error')
    await expect(installPreset('x')).rejects.not.toBeInstanceOf(InstallRefusedError)
  })
})
