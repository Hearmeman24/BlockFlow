import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postFile } from './post-file'

function makeFile(name = 'clip.mp4', type = 'video/mp4', content = 'abc'): File {
  return new File([content], name, { type })
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    text: async () => JSON.stringify(body),
  } as Response
}

function textResponse(body: string, status: number): Response {
  return {
    status,
    text: async () => body,
  } as Response
}

describe('postFile', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the parsed JSON body on success', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({ ok: true, video_url: '/outputs/a.mp4' }),
    )

    const res = await postFile('/api/blocks/video_loader/upload', makeFile())

    expect(res).toEqual({ ok: true, video_url: '/outputs/a.mp4' })
  })

  it('returns error payloads as parsed JSON (caller handles ok=false)', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'R2 not configured' }),
    )

    const res = await postFile('/api/blocks/video_loader/upload', makeFile())

    expect(res).toEqual({ ok: false, error: 'R2 not configured' })
  })

  it('throws a readable error when the response is not JSON (proxy 500)', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      textResponse('Internal Server Error', 500),
    )

    await expect(
      postFile('/api/blocks/video_loader/upload', makeFile()),
    ).rejects.toThrow('Upload failed (HTTP 500): Internal Server Error')
  })

  it('throws a readable error on an empty response body', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(textResponse('', 502))

    await expect(
      postFile('/api/blocks/video_loader/upload', makeFile()),
    ).rejects.toThrow('Upload failed (HTTP 502): (empty response body)')
  })

  it('truncates long non-JSON bodies in the error message', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      textResponse('<html>' + 'x'.repeat(500), 500),
    )

    await expect(
      postFile('/api/blocks/video_loader/upload', makeFile()),
    ).rejects.toThrow(/^Upload failed \(HTTP 500\): .{1,160}$/)
  })

  it('POSTs raw bytes with filename and content-type headers', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))

    await postFile('/api/blocks/video_loader/upload', makeFile('v.mp4', 'video/mp4'))

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/blocks/video_loader/upload')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(headers['X-Filename']).toBe('v.mp4')
    expect(headers['X-Content-Type']).toBe('video/mp4')
  })

  it('falls back to application/octet-stream when file.type is empty', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))

    await postFile('/api/blocks/video_loader/upload', new File(['d'], 'f.bin', { type: '' }))

    const [, init] = mockFetch.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Content-Type']).toBe('application/octet-stream')
  })

  it('propagates network errors from fetch', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network failure'))

    await expect(
      postFile('/api/blocks/video_loader/upload', makeFile()),
    ).rejects.toThrow('Network failure')
  })
})
