import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

import { ComfyGenUpdateBanner } from './comfygen-update-banner'

function mockFetch(handlers: Record<string, unknown>) {
  return vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const body = handlers[key]
    if (body === undefined) throw new Error(`unexpected fetch ${key}`)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
}

const STALE = { configured: true, stale: true, current_tag: 'v24', latest_tag: 'v25', release_notes: 'faster' }

beforeEach(() => {
  localStorage.clear()
  toastSuccess.mockReset()
  toastError.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

test('renders when stale and shows current → latest', async () => {
  vi.stubGlobal('fetch', mockFetch({ 'GET /api/comfygen/update-status': STALE }))
  render(<ComfyGenUpdateBanner />)
  expect(await screen.findByText(/ComfyGen has an update \(v24 → v25\)/)).toBeInTheDocument()
})

test('hidden when not stale', async () => {
  vi.stubGlobal('fetch', mockFetch({ 'GET /api/comfygen/update-status': { ...STALE, stale: false } }))
  const { container } = render(<ComfyGenUpdateBanner />)
  await Promise.resolve()
  await waitFor(() => expect(container).toBeEmptyDOMElement())
})

test('hidden when not configured', async () => {
  vi.stubGlobal('fetch', mockFetch({ 'GET /api/comfygen/update-status': { configured: false, stale: false, latest_tag: 'v25' } }))
  const { container } = render(<ComfyGenUpdateBanner />)
  await waitFor(() => expect(container).toBeEmptyDOMElement())
})

test('Dismiss persists and hides; stays hidden for same tag', async () => {
  vi.stubGlobal('fetch', mockFetch({ 'GET /api/comfygen/update-status': STALE }))
  const { unmount } = render(<ComfyGenUpdateBanner />)
  await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(screen.queryByText(/ComfyGen has an update/)).not.toBeInTheDocument())
  expect(localStorage.getItem('comfygen-update-dismissed:v25')).toBe('1')

  // re-mount: dismissed tag stays hidden
  unmount()
  render(<ComfyGenUpdateBanner />)
  await Promise.resolve()
  await waitFor(() => expect(screen.queryByText(/ComfyGen has an update/)).not.toBeInTheDocument())
})

test('re-shows for a higher tag after dismissing v25', async () => {
  localStorage.setItem('comfygen-update-dismissed:v25', '1')
  vi.stubGlobal('fetch', mockFetch({ 'GET /api/comfygen/update-status': { ...STALE, current_tag: 'v25', latest_tag: 'v26' } }))
  render(<ComfyGenUpdateBanner />)
  expect(await screen.findByText(/v25 → v26/)).toBeInTheDocument()
})

test('no banner and no crash when status fetch rejects', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network'))))
  const { container } = render(<ComfyGenUpdateBanner />)
  await waitFor(() => expect(container).toBeEmptyDOMElement())
})

test('Update failure toasts error and keeps the banner mounted', async () => {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(STALE) } as Response)
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ detail: 'RunPod update failed: boom' }) } as Response)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<ComfyGenUpdateBanner />)
  await userEvent.click(await screen.findByRole('button', { name: 'Update' }))
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('RunPod update failed: boom'))
  expect(screen.getByText(/ComfyGen has an update/)).toBeInTheDocument()
})

test('Update posts and toasts the propagation message', async () => {
  vi.stubGlobal('fetch', mockFetch({
    'GET /api/comfygen/update-status': STALE,
    'POST /api/comfygen/update': { ok: true, message: 'Update to v25 started — can take ~1 hour to propagate.' },
  }))
  render(<ComfyGenUpdateBanner />)
  await userEvent.click(await screen.findByRole('button', { name: 'Update' }))
  await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('~1 hour')))
})
