import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { blockDef } from '../custom_blocks/generated/upscale'

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function mockFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/blocks/upscale/settings') {
      return jsonResponse({ ok: true, has_env_api_key: false })
    }
    if (url === '/api/blocks/upscale/upscale') {
      return jsonResponse({ ok: true, job_ids: ['topaz-job-1'] })
    }
    if (url === '/api/blocks/upscale/status/topaz-job-1') {
      return jsonResponse({
        ok: true,
        job: {
          job_id: 'topaz-job-1',
          status: 'COMPLETED',
          local_video_url: '/outputs/topaz-upscaled.mp4',
        },
      })
    }
    return Promise.reject(new Error(`Unhandled fetch: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderBlock(blockId = 'upscale1') {
  const setOutput = vi.fn()
  const setStatusMessage = vi.fn()
  const setExecutionStatus = vi.fn()
  let execute: ExecuteFn | null = null
  const Comp = blockDef.component

  render(
    <Comp
      blockId={blockId}
      inputs={{
        video: [
          {
            kind: 'video-ref',
            local: '/outputs/source.mp4',
            url: 'https://tmpfiles.org/dl/source.mp4',
          },
        ],
      }}
      setOutput={setOutput}
      registerExecute={(fn) => {
        execute = fn as ExecuteFn
      }}
      setStatusMessage={setStatusMessage}
      setExecutionStatus={setExecutionStatus}
    />,
  )

  return { setOutput, setStatusMessage, setExecutionStatus, getExecute: () => execute }
}

function makeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key)
    }),
    clear: vi.fn(() => {
      data.clear()
    }),
  }
}

describe('Video Upscale input URL resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    vi.stubGlobal('localStorage', makeStorage({ topaz_api_key: 'test-topaz-key' }))
  })

  it('submits the local URL from VideoRef inputs emitted by Video Loader', async () => {
    const fetchMock = mockFetch()
    const { getExecute, setOutput } = renderBlock()
    const execute = getExecute()
    expect(execute).toBeTypeOf('function')

    await execute!({
      video: [
        {
          kind: 'video-ref',
          local: '/outputs/source.mp4',
          url: 'https://tmpfiles.org/dl/source.mp4',
        },
      ],
    }, new AbortController().signal)

    expect(fetchMock).toHaveBeenCalledWith('/api/blocks/upscale/upscale', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"source_videos":["/outputs/source.mp4"]'),
    }))
    expect(setOutput).toHaveBeenCalledWith('video', ['/outputs/topaz-upscaled.mp4'])
  })
})
