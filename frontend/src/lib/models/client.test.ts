import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  ALLOWED_MODEL_FOLDERS,
  deleteModels,
  downloadModel,
  getDownloadProgress,
  listModels,
  NoEndpointError,
  parseModelFolder,
  syncModels,
  clearDownloadState,
} from './client'

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response)
}

beforeEach(() => {
  vi.restoreAllMocks()
  global.fetch = vi.fn()
})

describe('models client', () => {
  test('exports the hard allowed folder list', () => {
    expect(ALLOWED_MODEL_FOLDERS).toEqual([
      'diffusion_models',
      'loras',
      'text_encoders',
      'vae',
      'upscale_models',
      'checkpoints',
    ])
  })

  test('parseModelFolder accepts only allowed folder names', () => {
    expect(parseModelFolder('loras')).toBe('loras')
    expect(parseModelFolder('../loras')).toBeNull()
    expect(parseModelFolder('controlnet')).toBeNull()
  })

  test('listModels throws NoEndpointError on endpoint 409 detail', async () => {
    mockFetch(409, { detail: 'no ComfyGen endpoint configured' })

    await expect(listModels()).rejects.toBeInstanceOf(NoEndpointError)
  })

  test('listModels reads the models payload', async () => {
    mockFetch(200, {
      folders: ALLOWED_MODEL_FOLDERS,
      models: [{
        folder: 'checkpoints',
        filename: 'base.safetensors',
        path: '/runpod-volume/ComfyUI/models/checkpoints/base.safetensors',
        source: 'unknown',
        source_id: null,
        base_model: null,
        trigger_words: [],
        size_bytes: 100,
        downloaded_at: null,
        updated_at: null,
      }],
      pruned: [],
      fetched_at: 1700000000,
      stale: false,
    })

    const result = await listModels()

    expect(fetch).toHaveBeenCalledWith('/api/models', { method: 'GET' })
    expect(result.models[0].folder).toBe('checkpoints')
  })

  test('syncModels posts to the sync route', async () => {
    mockFetch(200, { folders: ALLOWED_MODEL_FOLDERS, models: [], pruned: [], fetched_at: 1, stale: false })

    await syncModels()

    expect(fetch).toHaveBeenCalledWith('/api/models/sync', { method: 'POST' })
  })

  test('downloadModel sends selected destination folder', async () => {
    mockFetch(202, {
      state: 'queued',
      folder: 'vae',
      filename: 'model.safetensors',
      source: 'url',
      source_id: 'https://example.com/model.safetensors',
      started_at: '2026-06-03T00:00:00Z',
      completed_at: null,
      progress_percent: 0,
      log_tail: '',
      error: null,
      elapsed_seconds: null,
    })

    await downloadModel({
      source: 'url',
      url: 'https://example.com/model.safetensors',
      folder: 'vae',
      filename: 'model.safetensors',
    })

    expect(fetch).toHaveBeenCalledWith('/api/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'url',
        url: 'https://example.com/model.safetensors',
        folder: 'vae',
        filename: 'model.safetensors',
      }),
    })
  })

  test('downloadModel rejects invalid folders before fetch', async () => {
    await expect(downloadModel({
      source: 'url',
      url: 'https://example.com/model.safetensors',
      folder: '../vae',
    })).rejects.toThrow(/Invalid model folder/)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('deleteModels posts folder and filename items', async () => {
    mockFetch(207, {
      results: [
        { folder: 'checkpoints', filename: 'a.safetensors', path: '/p/a', deleted: true, error: null },
        { folder: 'checkpoints', filename: 'b.safetensors', path: '/p/b', deleted: false, error: 'in use' },
      ],
    })

    const result = await deleteModels([
      { folder: 'checkpoints', filename: 'a.safetensors' },
      { folder: 'checkpoints', filename: 'b.safetensors' },
    ])

    expect(result.results[1].error).toBe('in use')
    expect(fetch).toHaveBeenCalledWith('/api/models/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          { folder: 'checkpoints', filename: 'a.safetensors' },
          { folder: 'checkpoints', filename: 'b.safetensors' },
        ],
      }),
    })
  })

  test('progress and clear use the model download routes', async () => {
    mockFetch(200, {
      state: 'idle',
      folder: null,
      filename: null,
      source: null,
      source_id: null,
      started_at: null,
      completed_at: null,
      progress_percent: null,
      log_tail: '',
      error: null,
      elapsed_seconds: null,
    })
    await getDownloadProgress()
    expect(fetch).toHaveBeenLastCalledWith('/api/models/download/progress', { method: 'GET' })

    mockFetch(200, { ok: true })
    await clearDownloadState()
    expect(fetch).toHaveBeenLastCalledWith('/api/models/download/clear', { method: 'POST' })
  })
})
