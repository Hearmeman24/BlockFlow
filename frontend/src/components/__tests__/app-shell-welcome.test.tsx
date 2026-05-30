import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { WELCOME_STORAGE_KEY } from '../welcome-to-blockflow'

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

global.fetch = vi.fn().mockResolvedValue({
  json: async () => ({ advanced: false }),
}) as unknown as typeof fetch

import { AppShell } from '../app-shell'

function installLocalStorageStub() {
  const store = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
  }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

describe('AppShell welcome onboarding', () => {
  beforeEach(() => {
    installLocalStorageStub()
    localStorage.clear()
    pushMock.mockClear()
    pathname = '/generate'
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ advanced: false }),
    } as Response)
  })

  test('shows the welcome on /generate when it has not been dismissed', async () => {
    render(<AppShell><div>child page</div></AppShell>)

    expect(await screen.findByRole('heading', { name: /welcome to blockflow/i })).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument()
  })

  test('does not show the welcome outside /generate', async () => {
    pathname = '/settings'

    render(<AppShell><div>settings page</div></AppShell>)

    await waitFor(() => expect(screen.getByText('settings page')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /welcome to blockflow/i })).not.toBeInTheDocument()
  })

  test('does not show the welcome after it has been dismissed', async () => {
    localStorage.setItem(WELCOME_STORAGE_KEY, '1')

    render(<AppShell><div>child page</div></AppShell>)

    await waitFor(() => expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /welcome to blockflow/i })).not.toBeInTheDocument()
  })

  test('Set up ComfyGen opens the existing wizard from the app shell', async () => {
    const user = userEvent.setup()
    render(<AppShell><div>child page</div></AppShell>)

    await user.click(await screen.findByRole('button', { name: /set up comfygen/i }))

    expect(await screen.findByRole('dialog', { name: /set up comfygen endpoint/i })).toBeInTheDocument()
    expect(localStorage.getItem(WELCOME_STORAGE_KEY)).toBe('1')
  })

  test('Open Credentials routes to the credentials settings tab', async () => {
    const user = userEvent.setup()
    render(<AppShell><div>child page</div></AppShell>)

    await user.click(await screen.findByRole('button', { name: /open credentials/i }))

    expect(pushMock).toHaveBeenCalledWith('/settings?tab=credentials')
    expect(localStorage.getItem(WELCOME_STORAGE_KEY)).toBe('1')
  })

  test('opens the ComfyGen wizard when a block dispatches the setup event', async () => {
    localStorage.setItem(WELCOME_STORAGE_KEY, '1')
    render(<AppShell><div>child page</div></AppShell>)

    window.dispatchEvent(new CustomEvent('blockflow:open-comfygen-wizard'))

    expect(await screen.findByRole('dialog', { name: /set up comfygen endpoint/i })).toBeInTheDocument()
  })
})
