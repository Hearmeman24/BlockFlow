import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  isShortcutEnabled,
  ShortcutPrefsProvider,
  useShortcutPrefs,
  getShortcutPrefs,
  putShortcutPrefs,
} from './shortcuts-client'
import { KEYMAP } from '@/lib/pipeline/keymap'

const wrapper = ({ children }: { children: ReactNode }) => (
  <ShortcutPrefsProvider>{children}</ShortcutPrefsProvider>
)

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('isShortcutEnabled', () => {
  it('falls back to defaultEnabled when key is absent', () => {
    expect(isShortcutEnabled({}, 'nav-right', KEYMAP)).toBe(true)
  })
  it('respects the explicit value when present', () => {
    expect(isShortcutEnabled({ 'nav-right': false }, 'nav-right', KEYMAP)).toBe(false)
  })
})

describe('getShortcutPrefs / putShortcutPrefs', () => {
  it('GETs /api/settings/shortcuts and returns its body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ 'nav-right': false }), { status: 200 }),
    )
    await expect(getShortcutPrefs()).resolves.toEqual({ 'nav-right': false })
    expect(fetchSpy).toHaveBeenCalledWith('/api/settings/shortcuts')
  })

  it('PUTs the patch body and returns the updated prefs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ 'insert-downstream': false }), { status: 200 }),
    )
    const result = await putShortcutPrefs({ 'insert-downstream': false })
    expect(result).toEqual({ 'insert-downstream': false })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/settings/shortcuts',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ 'insert-downstream': false }),
      }),
    )
  })
})

describe('ShortcutPrefsProvider', () => {
  it('fetches prefs on mount and exposes masterEnabled=true by default', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    const { result } = renderHook(() => useShortcutPrefs(), { wrapper })
    await waitFor(() => expect(result.current.masterEnabled).toBe(true))
    expect(result.current.prefs).toEqual({})
  })

  it('setMaster(false) makes masterEnabled false and PUTs the sentinel key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ __master__: false }), { status: 200 }),
    )
    const { result } = renderHook(() => useShortcutPrefs(), { wrapper })
    await waitFor(() => expect(result.current.masterEnabled).toBe(true))
    await act(async () => {
      await result.current.setMaster(false)
    })
    expect(result.current.masterEnabled).toBe(false)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/settings/shortcuts',
      expect.objectContaining({
        body: JSON.stringify({ __master__: false }),
      }),
    )
  })

  it('setPref(id, false) PUTs and updates prefs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'nav-right': false }), { status: 200 }),
    )
    const { result } = renderHook(() => useShortcutPrefs(), { wrapper })
    await waitFor(() => expect(result.current.prefs).toEqual({}))
    await act(async () => {
      await result.current.setPref('nav-right', false)
    })
    expect(result.current.prefs).toEqual({ 'nav-right': false })
  })
})
