import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── navigation mocks ────────────────────────────────────────────────────────
const pushMock = vi.fn()
let mockPathname = '/generate'

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}))

// ── API mocks ────────────────────────────────────────────────────────────────
const deleteFlowMock = vi.fn()
const renameFlowMock = vi.fn()

vi.mock('@/lib/api', () => ({
  deleteFlow: (...args: unknown[]) => deleteFlowMock(...args),
  renameFlow: (...args: unknown[]) => renameFlowMock(...args),
}))

// ── tabs-context mock ────────────────────────────────────────────────────────
const saveActiveFlowMock = vi.fn()
const refreshAvailableFlowsMock = vi.fn()
const openFlowInNewTabMock = vi.fn()
const saveWorkspaceMock = vi.fn()
const loadWorkspaceMock = vi.fn()

const mockAvailableFlows: Array<{ name: string }> = []

vi.mock('@/lib/pipeline/tabs-context', () => ({
  usePipelineTabs: () => ({
    availableFlows: mockAvailableFlows,
    refreshAvailableFlows: refreshAvailableFlowsMock,
    saveActiveFlow: saveActiveFlowMock,
    openFlowInNewTab: openFlowInNewTabMock,
    saveWorkspace: saveWorkspaceMock,
    loadWorkspace: loadWorkspaceMock,
  }),
}))

// ── icon stubs ───────────────────────────────────────────────────────────────
vi.mock('@/components/settings/settings-nav-icon', () => ({
  SettingsNavIcon: () => <button type="button">Settings</button>,
}))
vi.mock('@/components/loras/loras-nav-icon', () => ({
  LorasNavIcon: () => <button type="button">LoRAs</button>,
}))
vi.mock('@/components/presets/presets-nav-icon', () => ({
  PresetsNavIcon: () => <button type="button">Presets</button>,
}))

// ── toast spy ────────────────────────────────────────────────────────────────
const toastErrorMock = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}))

// ── NAV_ITEMS constant ───────────────────────────────────────────────────────
// Import after mocks
import { NavBar } from '../nav-bar'
import { NAV_ITEMS } from '@/lib/nav-items'

describe('NavBar', () => {
  beforeEach(() => {
    mockPathname = '/generate'
    saveActiveFlowMock.mockReset()
    refreshAvailableFlowsMock.mockReset().mockResolvedValue(undefined)
    openFlowInNewTabMock.mockReset().mockResolvedValue(undefined)
    saveWorkspaceMock.mockReset().mockResolvedValue(undefined)
    loadWorkspaceMock.mockReset().mockResolvedValue(undefined)
    deleteFlowMock.mockReset().mockResolvedValue(undefined)
    renameFlowMock.mockReset().mockResolvedValue(undefined)
    toastErrorMock.mockReset()
    pushMock.mockReset()
    // reset shared array
    mockAvailableFlows.length = 0
  })

  // ── NAV_ITEMS drives nav links ─────────────────────────────────────────────
  test('renders a nav link for every NAV_ITEMS entry', () => {
    render(<NavBar />)
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: new RegExp(item.label, 'i') })).toBeInTheDocument()
    }
  })

  test('active link matches current pathname', () => {
    mockPathname = '/artifacts'
    render(<NavBar />)
    const artifactsLink = screen.getByRole('link', { name: /artifacts/i })
    expect(artifactsLink.className).toMatch(/bg-primary/)
  })

  // ── Save-As Dialog ─────────────────────────────────────────────────────────
  test('Save Flow As opens dialog with pre-filled default value', async () => {
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /save flow as/i }))

    const input = await screen.findByRole('textbox')
    expect(input).toBeInTheDocument()
    expect((input as HTMLInputElement).value).toBe('My Pipeline')
  })

  test('Save Flow As calls saveActiveFlow with submitted name only on confirm', async () => {
    saveActiveFlowMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /save flow as/i }))

    const input = await screen.findByRole('textbox')
    await user.clear(input)
    await user.type(input, 'My New Flow')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(saveActiveFlowMock).toHaveBeenCalledWith('My New Flow')
  })

  test('Save Flow As cancel is a no-op', async () => {
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /save flow as/i }))

    await screen.findByRole('textbox')
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(saveActiveFlowMock).not.toHaveBeenCalled()
  })

  // ── Save (fallback to Save-As) ─────────────────────────────────────────────
  test('Save Flow opens save-as dialog when saveActiveFlow throws (no existing name)', async () => {
    saveActiveFlowMock.mockRejectedValue(new Error('no name'))
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /^save flow$/i }))

    expect(await screen.findByRole('textbox')).toBeInTheDocument()
  })

  test('Save Flow surfaces a toast on save failure', async () => {
    saveActiveFlowMock.mockRejectedValue(new Error('no name'))
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /^save flow$/i }))

    // Fill in name and submit — second saveActiveFlow also fails
    saveActiveFlowMock.mockRejectedValue(new Error('save failed'))
    const input = await screen.findByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Bad Flow')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
  })

  // ── Rename Dialog ──────────────────────────────────────────────────────────
  test('Rename dialog opens pre-filled with the flow name', async () => {
    mockAvailableFlows.push({ name: 'AlphaFlow' })
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    // hover to reveal the rename button
    const renameBtn = await screen.findByRole('button', { name: /rename flow AlphaFlow/i })
    await user.click(renameBtn)

    const input = await screen.findByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('AlphaFlow')
  })

  test('Rename calls renameFlow and refreshes on submit', async () => {
    mockAvailableFlows.push({ name: 'AlphaFlow' })
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('button', { name: /rename flow AlphaFlow/i }))

    const input = await screen.findByRole('textbox')
    await user.clear(input)
    await user.type(input, 'BetaFlow')
    await user.click(screen.getByRole('button', { name: /^rename$/i }))

    await waitFor(() => expect(renameFlowMock).toHaveBeenCalledWith('AlphaFlow', 'BetaFlow'))
    await waitFor(() => expect(refreshAvailableFlowsMock).toHaveBeenCalled())
  })

  test('Rename cancel is a no-op', async () => {
    mockAvailableFlows.push({ name: 'AlphaFlow' })
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('button', { name: /rename flow AlphaFlow/i }))

    await screen.findByRole('textbox')
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(renameFlowMock).not.toHaveBeenCalled()
  })

  // ── Delete AlertDialog ─────────────────────────────────────────────────────
  test('Delete AlertDialog opens on delete button click', async () => {
    mockAvailableFlows.push({ name: 'AlphaFlow' })
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('button', { name: /delete flow AlphaFlow/i }))

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText(/delete.*AlphaFlow.*\?/i)).toBeInTheDocument()
  })

  test('Delete confirm calls deleteFlow and refreshes', async () => {
    mockAvailableFlows.push({ name: 'AlphaFlow' })
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('button', { name: /delete flow AlphaFlow/i }))

    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    await waitFor(() => expect(deleteFlowMock).toHaveBeenCalledWith('AlphaFlow'))
    await waitFor(() => expect(refreshAvailableFlowsMock).toHaveBeenCalled())
  })

  test('Delete cancel is a no-op', async () => {
    mockAvailableFlows.push({ name: 'AlphaFlow' })
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('button', { name: /delete flow AlphaFlow/i }))

    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(deleteFlowMock).not.toHaveBeenCalled()
  })

  // ── Workspace name Dialog ──────────────────────────────────────────────────
  test('Save All Tabs opens dialog pre-filled with My Workspace', async () => {
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /save all tabs/i }))

    const input = await screen.findByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('My Workspace')
  })

  test('Save All Tabs calls saveWorkspace with submitted name', async () => {
    const user = userEvent.setup()
    render(<NavBar />)

    await user.click(screen.getByRole('button', { name: /file/i }))
    await user.click(await screen.findByRole('menuitem', { name: /save all tabs/i }))

    const input = await screen.findByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Weekend Work')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(saveWorkspaceMock).toHaveBeenCalledWith('Weekend Work'))
  })
})
