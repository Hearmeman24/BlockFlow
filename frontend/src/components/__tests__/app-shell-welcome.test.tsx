import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const pushMock = vi.fn()
let pathname = '/generate'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/components/nav-bar', () => ({
  NavBar: () => <nav aria-label="nav">nav</nav>,
}))

vi.mock('@/components/sidebar', () => ({
  Sidebar: () => <aside>sidebar</aside>,
}))

vi.mock('@/components/pipeline/pipeline-tabs', () => ({
  PipelineTabs: () => <div data-testid="pipeline-tabs">pipeline tabs</div>,
}))

vi.mock('@/lib/pipeline/tabs-context', () => ({
  PipelineTabsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/wizard/comfygen-wizard', () => ({
  ComfyGenWizard: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Set up ComfyGen endpoint">
      <button type="button" onClick={onClose}>Close wizard</button>
    </div>
  ),
}))

vi.mock('@/lib/pipeline/registry', () => ({
  setAdvancedMode: vi.fn(),
}))

vi.mock('@/components/pipeline/custom_blocks/_register', () => ({}))

vi.mock('@/lib/settings/client', () => ({
  ASSET_STORAGE_MODE_PREF: 'asset_storage_mode',
  getAppPref: vi.fn(),
  setAssetStorageMode: vi.fn().mockResolvedValue(undefined),
  setCredential: vi.fn().mockResolvedValue(undefined),
  isAssetStorageMode: (value: string | null | undefined) => (
    value === 'local_only' || value === 'tmpfiles' || value === 'r2_signed'
  ),
}))

global.fetch = vi.fn().mockResolvedValue({
  json: async () => ({ advanced: false }),
}) as unknown as typeof fetch

import { getAppPref } from '@/lib/settings/client'
import { AppShell } from '../app-shell'

describe('AppShell setup onboarding', () => {
  beforeEach(() => {
    pushMock.mockClear()
    pathname = '/generate'
    vi.mocked(getAppPref).mockReset()
    vi.mocked(getAppPref).mockResolvedValue(null)
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ advanced: false }),
    } as Response)
  })

  test('shows the setup wizard on /generate when asset storage mode is unset', async () => {
    render(<AppShell><div>child page</div></AppShell>)

    expect(await screen.findByRole('heading', { name: /choose asset storage/i })).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument()
  })

  test('does not show the setup wizard outside /generate', async () => {
    pathname = '/settings'

    render(<AppShell><div>settings page</div></AppShell>)

    await waitFor(() => expect(screen.getByText('settings page')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /choose asset storage/i })).not.toBeInTheDocument()
  })

  test('does not show the setup wizard after asset storage mode is configured', async () => {
    vi.mocked(getAppPref).mockResolvedValue('tmpfiles')

    render(<AppShell><div>child page</div></AppShell>)

    await waitFor(() => expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /choose asset storage/i })).not.toBeInTheDocument()
  })

  test('Set up ComfyGen opens the existing wizard after storage selection', async () => {
    const user = userEvent.setup()
    render(<AppShell><div>child page</div></AppShell>)

    await user.click(await screen.findByRole('button', { name: /temporary public urls/i }))
    await user.click(await screen.findByRole('button', { name: /set up comfygen/i }))

    expect(await screen.findByRole('dialog', { name: /set up comfygen endpoint/i })).toBeInTheDocument()
  })

  test('opens the ComfyGen wizard when a block dispatches the setup event', async () => {
    vi.mocked(getAppPref).mockResolvedValue('tmpfiles')
    render(<AppShell><div>child page</div></AppShell>)

    window.dispatchEvent(new CustomEvent('blockflow:open-comfygen-wizard'))

    expect(await screen.findByRole('dialog', { name: /set up comfygen endpoint/i })).toBeInTheDocument()
  })
})
