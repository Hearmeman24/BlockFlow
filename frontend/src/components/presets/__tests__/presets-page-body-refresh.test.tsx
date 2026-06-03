/**
 * Tests for the /presets Refresh button's user feedback (sgs-ui-ag2).
 *
 * Pre-fix: click → silent fetch, no spinner, no result, errors swallowed.
 * Post-fix: button disables + shows "Refreshing…" while in flight; on
 * success renders a green status banner with counts; on error renders a
 * destructive banner with the message.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
  vi.useRealTimers()
  mocks.getPresetManifest.mockReset().mockResolvedValue(emptyManifest())
  mocks.listInstalledPresets.mockReset().mockResolvedValue([])
  mocks.refreshInstalledPresets.mockReset()
  mocks.installPreset.mockReset()
  mocks.uninstallPreset.mockReset()
  mocks.cancelInstall.mockReset()
  mocks.getInstallProgress.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PresetsPageBody — loading skeleton (Phase 3)', () => {
  test('renders skeleton cards while manifest is loading, not "Loading…" text', async () => {
    // Never resolve so we stay in the loading state
    mocks.getPresetManifest.mockReturnValue(new Promise(() => {}))

    render(<PresetsPageBody />)

    // Skeleton should appear immediately
    expect(screen.getByTestId('presets-cards-skeleton')).toBeInTheDocument()
    // No plain "Loading…" text
    expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument()
  })

  test('skeleton disappears and cards render after manifest loads', async () => {
    mocks.getPresetManifest.mockResolvedValue({
      presets: [{
        id: 'wan-animate',
        name: 'WAN Animate',
        description: 'Video preset',
        comfygen_min_version: '0.1.0',
        disk_size_estimate_gb: 40,
        preset_url: 'https://example/preset.json',
      }],
      cache: 'fresh' as const,
      fetched_at: '2026-06-03T00:00:00Z',
    })

    render(<PresetsPageBody />)

    // Wait for the preset card
    expect(await screen.findByText('WAN Animate')).toBeInTheDocument()

    // Skeleton is gone
    expect(screen.queryByTestId('presets-cards-skeleton')).not.toBeInTheDocument()
  })
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

describe('PresetsPageBody install recovery', () => {
  test('installer pod startup failures offer GPU fallback on the presets page', async () => {
    const user = userEvent.setup()
    mocks.getPresetManifest.mockResolvedValue({
      presets: [{
        id: 'hidream-o1',
        name: 'HiDream O1 Image',
        description: 'Starter image preset',
        comfygen_min_version: '0.2.0',
        disk_size_estimate_gb: 20,
        preset_url: 'https://example/preset.json',
      }],
      cache: 'fresh' as const,
      fetched_at: '2026-05-31T00:00:00Z',
    })
    mocks.installPreset.mockResolvedValue({
      preset_id: 'hidream-o1',
      state: 'running',
      files_total: 4,
      started_at: '2026-05-31T00:00:00Z',
    })
    mocks.getInstallProgress.mockResolvedValue({
      state: 'error',
      preset_id: 'hidream-o1',
      started_at: '2026-05-31T00:00:00Z',
      completed_at: '2026-05-31T00:03:00Z',
      files_total: 4,
      files_done: 0,
      phase: 'preflight',
      pod_id: 'wd2023rnlvslk1',
      error_kind: 'installer_pod_failed',
      error: 'install error at health: pod wd2023rnlvslk1 not healthy after 180s; last=status=404 payload=None',
    })

    render(<PresetsPageBody />)
    await user.click(await screen.findByRole('button', { name: /^Install$/i }))

    await waitFor(
      () => expect(mocks.getInstallProgress).toHaveBeenCalled(),
      { timeout: 3000 },
    )

    expect((await screen.findAllByText(/CPU installer pod failed/i)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /use gpu instead/i })).toBeInTheDocument()
  })

  test('GPU fallback on the presets page skips CPU installer pod milestones immediately', async () => {
    const user = userEvent.setup()
    mocks.getPresetManifest.mockResolvedValue({
      presets: [{
        id: 'hidream-o1',
        name: 'HiDream O1 Image',
        description: 'Starter image preset',
        comfygen_min_version: '0.2.0',
        disk_size_estimate_gb: 20,
        preset_url: 'https://example/preset.json',
      }],
      cache: 'fresh' as const,
      fetched_at: '2026-05-31T00:00:00Z',
    })
    mocks.installPreset.mockResolvedValue({
      preset_id: 'hidream-o1',
      state: 'running',
      files_total: 4,
      started_at: '2026-05-31T00:00:00Z',
    })
    mocks.getInstallProgress.mockResolvedValue({
      state: 'error',
      preset_id: 'hidream-o1',
      started_at: '2026-05-31T00:00:00Z',
      completed_at: '2026-05-31T00:03:00Z',
      files_total: 4,
      files_done: 0,
      phase: 'preflight',
      pod_id: 'wd2023rnlvslk1',
      error_kind: 'installer_pod_failed',
      error: 'install error at health: pod wd2023rnlvslk1 not healthy after 180s; last=status=404 payload=None',
    })

    render(<PresetsPageBody />)
    await user.click(await screen.findByRole('button', { name: /^Install$/i }))
    await waitFor(
      () => expect(mocks.getInstallProgress).toHaveBeenCalled(),
      { timeout: 3000 },
    )
    await user.click(await screen.findByRole('button', { name: /use gpu instead/i }))

    await waitFor(() => {
      expect(mocks.installPreset).toHaveBeenLastCalledWith('hidream-o1', { mode: 'gpu' })
    })
    expect(screen.queryByText(/Deploying installer pod/i)).not.toBeInTheDocument()
  })
})
