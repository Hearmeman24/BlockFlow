/**
 * Tests for consolidated UI primitives in the presets components.
 *
 * Covers:
 * - Install button fires onInstall
 * - AlertDialog confirm/cancel gates the uninstall action
 * - Progress reflects value in InstallMilestones
 * - Error banners render messages via AlertPanel (shared atom)
 * - EmptyState (shared atom) renders correctly via PresetsPageBody
 * - PageHeader (shared atom) renders title and actions via PresetsPageBody
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
  return { ...actual, ...mocks }
})

import { PresetsPageBody } from '../presets-page-body'
import { InstallMilestones } from '../install-milestones'
import type { InstallProgress } from '@/lib/settings/client'

// ─── helpers ────────────────────────────────────────────────────────────────

function singlePresetManifest(overrides = {}) {
  return {
    presets: [{
      id: 'wan-animate',
      name: 'Wan Animate',
      description: 'Animation preset',
      comfygen_min_version: '0.1.0',
      disk_size_estimate_gb: 40,
      preset_url: 'https://example/preset.json',
      ...overrides,
    }],
    cache: 'fresh' as const,
    fetched_at: '2026-06-01T00:00:00Z',
  }
}

function emptyManifest() {
  return { presets: [], cache: 'fresh' as const, fetched_at: '2026-06-01T00:00:00Z' }
}

function makeProgress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return {
    state: 'running',
    preset_id: 'wan-animate',
    started_at: '2026-06-01T00:00:00Z',
    completed_at: null,
    files_total: 4,
    files_done: 0,
    error: null,
    install_mode: 'cpu',
    phase: 'download',
    bytes_done: 10_000_000_000,
    total_download_bytes: 40_000_000_000,
    ...overrides,
  }
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

// ─── Install button fires onInstall ─────────────────────────────────────────

describe('Install button', () => {
  test('clicking Install calls installPreset with the preset id', async () => {
    mocks.getPresetManifest.mockResolvedValue(singlePresetManifest())
    mocks.installPreset.mockResolvedValue({
      preset_id: 'wan-animate',
      state: 'running',
      files_total: 4,
      started_at: '2026-06-01T00:00:00Z',
    })

    const user = userEvent.setup()
    render(<PresetsPageBody />)

    const btn = await screen.findByRole('button', { name: /^Install$/i })
    await user.click(btn)

    expect(mocks.installPreset).toHaveBeenCalledWith('wan-animate', { mode: 'cpu' })
  })

  test('Install button is disabled while another install is running', async () => {
    mocks.getPresetManifest.mockResolvedValue({
      presets: [
        { id: 'wan-animate', name: 'Wan Animate', description: 'A', comfygen_min_version: '0.1.0', disk_size_estimate_gb: 40, preset_url: '' },
        { id: 'other-preset', name: 'Other', description: 'B', comfygen_min_version: '0.1.0', disk_size_estimate_gb: 10, preset_url: '' },
      ],
      cache: 'fresh' as const,
      fetched_at: '2026-06-01T00:00:00Z',
    })
    // First install puts us in running state
    mocks.installPreset.mockResolvedValue({
      preset_id: 'wan-animate',
      state: 'running',
      files_total: 4,
      started_at: '2026-06-01T00:00:00Z',
    })

    const user = userEvent.setup()
    render(<PresetsPageBody />)

    const btns = await screen.findAllByRole('button', { name: /^Install$/i })
    // Click the first install button
    await user.click(btns[0])

    // Now all install buttons should be disabled
    await waitFor(() => {
      const allInstallBtns = screen.getAllByRole('button', { name: /^Install$/i })
      allInstallBtns.forEach((b) => expect(b).toBeDisabled())
    })
  })
})

// ─── AlertDialog confirm/cancel gates uninstall ──────────────────────────────

describe('Uninstall AlertDialog', () => {
  beforeEach(() => {
    mocks.listInstalledPresets.mockResolvedValue([
      { preset_id: 'wan-animate', disk_size_gb: 40, workflows: [] },
    ])
    mocks.getPresetManifest.mockResolvedValue(singlePresetManifest())
  })

  test('clicking Uninstall opens the AlertDialog without calling uninstallPreset', async () => {
    const user = userEvent.setup()
    render(<PresetsPageBody />)

    // The catalog row renders an "Uninstall" button (exact label, no "preset" suffix).
    // The detail panel renders "Uninstall preset" — use exact name to avoid ambiguity.
    const [btn] = await screen.findAllByRole('button', { name: 'Uninstall' })
    await user.click(btn)

    // Dialog should appear
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    // uninstallPreset not called yet
    expect(mocks.uninstallPreset).not.toHaveBeenCalled()
  })

  test('confirming in AlertDialog calls uninstallPreset', async () => {
    mocks.uninstallPreset.mockResolvedValue({ ok: true, deleted_count: 1, errors: [] })
    const user = userEvent.setup()
    render(<PresetsPageBody />)

    const [btn] = await screen.findAllByRole('button', { name: 'Uninstall' })
    await user.click(btn)
    // Wait for dialog
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toBeInTheDocument()

    // Click the confirm action button (labeled "Uninstall" inside the dialog footer).
    // Scope to the dialog to avoid matching the row-level "Uninstall" button.
    const confirmBtn = within(dialog).getByRole('button', { name: 'Uninstall' })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mocks.uninstallPreset).toHaveBeenCalledWith('wan-animate')
    })
  })

  test('cancelling in AlertDialog does NOT call uninstallPreset', async () => {
    const user = userEvent.setup()
    render(<PresetsPageBody />)

    const [btn] = await screen.findAllByRole('button', { name: 'Uninstall' })
    await user.click(btn)
    const dialog = await screen.findByRole('alertdialog')

    await user.click(within(dialog).getByRole('button', { name: /Cancel/i }))

    // Dialog should close and uninstall not called
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(mocks.uninstallPreset).not.toHaveBeenCalled()
  })

  test('dialog message includes preset id and size hint', async () => {
    const user = userEvent.setup()
    render(<PresetsPageBody />)

    const [btn] = await screen.findAllByRole('button', { name: 'Uninstall' })
    await user.click(btn)
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog.textContent).toContain('wan-animate')
    expect(dialog.textContent).toContain('40')
  })
})

// ─── Progress bar reflects value ─────────────────────────────────────────────

describe('InstallMilestones progress bar', () => {
  test('progress bar renders with correct percentage during download phase', () => {
    render(<InstallMilestones progress={makeProgress({
      phase: 'download',
      bytes_done: 10_000_000_000,
      total_download_bytes: 40_000_000_000,
    })} />)

    const bar = screen.getByTestId('install-progress-bar')
    expect(bar).toBeInTheDocument()

    // Progress primitive renders indicator with transform: translateX(-(100-pct)%)
    const indicator = bar.querySelector('[data-slot="progress-indicator"]') as HTMLElement
    expect(indicator).not.toBeNull()
    expect(indicator.style.transform).toBe('translateX(-75%)')
  })

  test('progress bar is hidden during non-download phases', () => {
    render(<InstallMilestones progress={makeProgress({ phase: 'preflight' })} />)
    expect(screen.queryByTestId('install-progress-bar')).toBeNull()
  })

  test('progress bar is hidden when total_download_bytes is 0', () => {
    render(<InstallMilestones progress={makeProgress({
      phase: 'download',
      total_download_bytes: 0,
      bytes_done: 0,
    })} />)
    expect(screen.queryByTestId('install-progress-bar')).toBeNull()
  })
})

// ─── Error banners render messages via PresetsPageBody ───────────────────────

describe('AlertPanel usage in PresetsPageBody', () => {
  test('manifest error banner renders error message', async () => {
    mocks.getPresetManifest.mockRejectedValue(new Error('DNS resolution failed'))
    render(<PresetsPageBody />)

    const banner = await screen.findByText(/DNS resolution failed/)
    expect(banner).toBeInTheDocument()
  })

  test('actionErr banner renders after failed uninstall', async () => {
    mocks.listInstalledPresets.mockResolvedValue([{ preset_id: 'wan-animate', workflows: [] }])
    mocks.getPresetManifest.mockResolvedValue(singlePresetManifest())
    mocks.uninstallPreset.mockRejectedValue(new Error('volume not mounted'))

    const user = userEvent.setup()
    render(<PresetsPageBody />)

    const [btn] = await screen.findAllByRole('button', { name: 'Uninstall' })
    await user.click(btn)
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }))

    await waitFor(() => {
      expect(screen.getByText(/volume not mounted/)).toBeInTheDocument()
    })
  })
})

// ─── EmptyState renders via PresetsPageBody ──────────────────────────────────

describe('EmptyState via PresetsPageBody', () => {
  test('PresetsPageBody shows empty state text when manifest has no presets', async () => {
    mocks.getPresetManifest.mockResolvedValue(emptyManifest())
    render(<PresetsPageBody />)

    expect(await screen.findByText('No presets in the registry yet.')).toBeInTheDocument()
  })
})

// ─── PageHeader via PresetsPageBody ──────────────────────────────────────────

describe('PageHeader via PresetsPageBody', () => {
  test('renders page title "Presets"', async () => {
    render(<PresetsPageBody />)
    expect(await screen.findByRole('heading', { name: 'Presets', level: 1 })).toBeInTheDocument()
  })

  test('renders Refresh button in the header slot', async () => {
    render(<PresetsPageBody />)
    expect(await screen.findByRole('button', { name: /^Refresh$/i })).toBeInTheDocument()
  })
})
