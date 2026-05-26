/**
 * Tests for the /presets Refresh button's user feedback (sgs-ui-ag2).
 *
 * Pre-fix: click → silent fetch, no spinner, no result, errors swallowed.
 * Post-fix: button disables + shows "Refreshing…" while in flight; on
 * success renders a green status banner with counts; on error renders a
 * destructive banner with the message.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => ({
  getPresetManifest: vi.fn(),
  refreshInstalledPresets: vi.fn(),
  listInstalledPresets: vi.fn(),
  installPreset: vi.fn(),
  uninstallPreset: vi.fn(),
  cancelInstall: vi.fn(),
  getInstallProgress: vi.fn(),
}))

vi.mock('@/lib/settings/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings/client')>()
  return {
    ...actual,
    ...mocks,
  }
})

import { PresetsPageBody } from '../presets-page-body'

function emptyManifest() {
  return { presets: [], cache: 'fresh' as const, fetched_at: '2026-05-26T00:00:00Z' }
}

beforeEach(() => {
  mocks.getPresetManifest.mockReset().mockResolvedValue(emptyManifest())
  mocks.listInstalledPresets.mockReset().mockResolvedValue([])
  mocks.refreshInstalledPresets.mockReset()
})

describe('PresetsPageBody Refresh button', () => {
  test('button disables and shows in-flight label while refresh is running', async () => {
    // Hold the resolution so we can assert mid-flight UI state.
    let resolveRefresh!: (v: unknown) => void
    mocks.refreshInstalledPresets.mockImplementation(
      () => new Promise((res) => { resolveRefresh = res })
    )

    const user = userEvent.setup()
    render(<PresetsPageBody />)
    const btn = await screen.findByRole('button', { name: /^Refresh$/i })

    await user.click(btn)

    // Mid-flight: button disabled + label switches to a loading state.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refreshing/i })).toBeDisabled()
    })

    // Resolve and assert the button comes back to its normal label.
    resolveRefresh({ refreshed: [], skipped: [], errors: [] })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Refresh$/i })).not.toBeDisabled()
    })
  })

  test('on success renders a status banner with counts', async () => {
    mocks.refreshInstalledPresets.mockResolvedValue({
      refreshed: [{ preset_id: 'wan22-svi-4pass' }, { preset_id: 'wan-animate' }],
      skipped: [{ preset_id: 'old-preset', reason: 'not in manifest' }],
      errors: [],
    })
    const user = userEvent.setup()
    render(<PresetsPageBody />)
    const btn = await screen.findByRole('button', { name: /^Refresh$/i })

    await user.click(btn)

    const banner = await screen.findByTestId('refresh-status-banner')
    expect(banner.textContent).toMatch(/Refreshed 2/)
    expect(banner.textContent).toMatch(/1 skipped/)
  })

  test('on error renders a destructive banner with the message', async () => {
    mocks.refreshInstalledPresets.mockRejectedValue(new Error('registry HTTP 503'))
    const user = userEvent.setup()
    render(<PresetsPageBody />)
    const btn = await screen.findByRole('button', { name: /^Refresh$/i })

    await user.click(btn)

    const banner = await screen.findByTestId('refresh-status-banner')
    expect(banner.textContent).toContain('registry HTTP 503')
    // Destructive banner styling — assert by role-derived class or a
    // dedicated data attribute. We use a data-tone attribute the
    // component sets so we don't lock to Tailwind class names.
    expect(banner.dataset.tone).toBe('error')
  })

  test('per-preset errors in the summary surface as a warning banner', async () => {
    mocks.refreshInstalledPresets.mockResolvedValue({
      refreshed: [{ preset_id: 'wan-animate' }],
      skipped: [],
      errors: [{ preset_id: 'wan22-svi-4pass', error: 'HTTP 404' }],
    })
    const user = userEvent.setup()
    render(<PresetsPageBody />)
    const btn = await screen.findByRole('button', { name: /^Refresh$/i })

    await user.click(btn)

    const banner = await screen.findByTestId('refresh-status-banner')
    expect(banner.textContent).toMatch(/1 error/)
    expect(banner.dataset.tone).toBe('warning')
  })
})

// vitest provides beforeEach via importing from 'vitest' explicitly:
import { beforeEach } from 'vitest'
