import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useBlockHealth } from './use-block-health'

const HEALTH_URL = '/api/blocks/test/health'

function makeFetch(ok: boolean, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(body),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBlockHealth', () => {
  it('starts as null before the fetch resolves', () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useBlockHealth(HEALTH_URL))
    expect(result.current.healthy).toBeNull()
  })

  it('sets healthy to true when response is ok', async () => {
    global.fetch = makeFetch(true, { some_key_present: true })
    const { result } = renderHook(() => useBlockHealth(HEALTH_URL))
    await waitFor(() => expect(result.current.healthy).toBe(true))
  })

  it('sets healthy to false when response is not ok', async () => {
    global.fetch = makeFetch(false, {})
    const { result } = renderHook(() => useBlockHealth(HEALTH_URL))
    await waitFor(() => expect(result.current.healthy).toBe(false))
  })

  it('sets healthy to false when fetch rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useBlockHealth(HEALTH_URL))
    await waitFor(() => expect(result.current.healthy).toBe(false))
  })

  it('recheck() refetches the endpoint', async () => {
    global.fetch = makeFetch(true)
    const { result } = renderHook(() => useBlockHealth(HEALTH_URL))
    await waitFor(() => expect(result.current.healthy).toBe(true))

    expect(global.fetch).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.recheck()
    })

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(global.fetch).toHaveBeenCalledWith(HEALTH_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('does not setState after unmount', async () => {
    let resolvePromise!: (value: Response) => void
    const neverSettles = new Promise<Response>((resolve) => {
      resolvePromise = resolve
    })
    global.fetch = vi.fn().mockReturnValue(neverSettles)

    const { result, unmount } = renderHook(() => useBlockHealth(HEALTH_URL))
    expect(result.current.healthy).toBeNull()

    unmount()

    // Now resolve the fetch after unmount — should not throw / warn
    act(() => {
      resolvePromise({
        ok: true,
        json: () => Promise.resolve({}),
      } as unknown as Response)
    })

    // healthy must remain null; no setState-after-unmount warning
    expect(result.current.healthy).toBeNull()
  })

  it('aborts the in-flight fetch on unmount', async () => {
    const abortSpy = vi.fn()
    const mockAbort = vi.spyOn(AbortController.prototype, 'abort').mockImplementation(abortSpy)

    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}))
    const { unmount } = renderHook(() => useBlockHealth(HEALTH_URL))
    unmount()

    expect(abortSpy).toHaveBeenCalled()
    mockAbort.mockRestore()
  })
})
