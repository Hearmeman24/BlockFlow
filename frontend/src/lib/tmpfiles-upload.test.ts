import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadToTmpfiles } from './tmpfiles-upload'

const UPLOAD_URL = '/api/blocks/upload_image_to_tmpfiles/upload'

function makeFile(name = 'photo.jpg', type = 'image/jpeg', content = 'abc'): File {
  return new File([content], name, { type })
}

describe('uploadToTmpfiles', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns image_url on success', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, image_url: 'https://tmpfiles.org/abc.jpg' }),
    } as Response)

    const file = makeFile('photo.jpg', 'image/jpeg')
    const result = await uploadToTmpfiles(file)

    expect(result).toBe('https://tmpfiles.org/abc.jpg')
  })

  it('calls the correct URL with POST method', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, image_url: 'https://tmpfiles.org/abc.jpg' }),
    } as Response)

    const file = makeFile('my-image.png', 'image/png')
    await uploadToTmpfiles(file)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(UPLOAD_URL)
    expect((init as RequestInit).method).toBe('POST')
  })

  it('sends X-Filename header with the file name', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, image_url: 'https://tmpfiles.org/abc.jpg' }),
    } as Response)

    const file = makeFile('my-special-image.webp', 'image/webp')
    await uploadToTmpfiles(file)

    const [, init] = mockFetch.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Filename']).toBe('my-special-image.webp')
  })

  it('sends Content-Type: application/octet-stream', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, image_url: 'https://tmpfiles.org/x.jpg' }),
    } as Response)

    const file = makeFile('x.jpg', 'image/jpeg')
    await uploadToTmpfiles(file)

    const [, init] = mockFetch.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/octet-stream')
  })

  it('throws with data.error when data.ok is false', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: false, error: 'quota exceeded' }),
    } as Response)

    const file = makeFile()
    await expect(uploadToTmpfiles(file)).rejects.toThrow('quota exceeded')
  })

  it('throws "upload failed" when data.ok is false and no data.error', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: false }),
    } as Response)

    const file = makeFile()
    await expect(uploadToTmpfiles(file)).rejects.toThrow('upload failed')
  })

  it('throws when image_url is missing even if ok is true', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true }),
    } as Response)

    const file = makeFile()
    await expect(uploadToTmpfiles(file)).rejects.toThrow('upload failed')
  })

  it('throws when fetch rejects (network error)', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockRejectedValueOnce(new Error('Network failure'))

    const file = makeFile()
    await expect(uploadToTmpfiles(file)).rejects.toThrow('Network failure')
  })

  it('falls back to image/png for X-Content-Type when file.type is empty', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, image_url: 'https://tmpfiles.org/y.jpg' }),
    } as Response)

    // Create a file with no type
    const file = new File(['data'], 'file.bin', { type: '' })
    await uploadToTmpfiles(file)

    const [, init] = mockFetch.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Content-Type']).toBe('image/png')
  })

  it('uses the actual file.type when present for X-Content-Type', async () => {
    const mockFetch = vi.mocked(global.fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, image_url: 'https://tmpfiles.org/z.webp' }),
    } as Response)

    const file = makeFile('z.webp', 'image/webp')
    await uploadToTmpfiles(file)

    const [, init] = mockFetch.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Content-Type']).toBe('image/webp')
  })
})
