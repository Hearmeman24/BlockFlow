/**
 * Tests for the SettingsLayout component (sgs-ui-wisp-las.1 Stage 3).
 *
 * SettingsLayout is the presentational shell of the /settings page:
 *   - Left in-page sidebar with 4 tab links (Credentials, Endpoints, Storage, App)
 *   - Main content area renders whichever tab is active
 *   - Tab list is fixed; the page above this component controls which is active
 *
 * Tab content for each section is delivered by later stages — this stage
 * ships the shell + tab navigation only.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SettingsLayout, SETTINGS_TABS, type SettingsTabId } from '../layout'

describe('SettingsLayout', () => {
  test('renders all four tab labels in the sidebar', () => {
    render(
      <SettingsLayout activeTab="credentials" onTabChange={() => {}}>
        <div>placeholder</div>
      </SettingsLayout>,
    )

    expect(screen.getByRole('button', { name: /credentials/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /endpoints/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /storage/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /app/i })).toBeInTheDocument()
  })

  test('marks the active tab visually distinct from the others', () => {
    render(
      <SettingsLayout activeTab="endpoints" onTabChange={() => {}}>
        <div>content</div>
      </SettingsLayout>,
    )

    const endpoints = screen.getByRole('button', { name: /endpoints/i })
    const credentials = screen.getByRole('button', { name: /credentials/i })

    // The active tab has aria-current="page" — the only marker the test should
    // depend on (visual styling is allowed to change without breaking tests).
    expect(endpoints).toHaveAttribute('aria-current', 'page')
    expect(credentials).not.toHaveAttribute('aria-current')
  })

  test('renders children in the main content area', () => {
    render(
      <SettingsLayout activeTab="app" onTabChange={() => {}}>
        <div data-testid="content">my tab body</div>
      </SettingsLayout>,
    )

    expect(screen.getByTestId('content')).toBeInTheDocument()
    expect(screen.getByText('my tab body')).toBeInTheDocument()
  })

  test('clicking a tab calls onTabChange with that tab id', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(
      <SettingsLayout activeTab="credentials" onTabChange={onTabChange}>
        <div />
      </SettingsLayout>,
    )

    await user.click(screen.getByRole('button', { name: /endpoints/i }))
    expect(onTabChange).toHaveBeenCalledWith('endpoints')

    await user.click(screen.getByRole('button', { name: /storage/i }))
    expect(onTabChange).toHaveBeenLastCalledWith('storage')
  })

  test('clicking the currently-active tab is a no-op (does not re-call onTabChange)', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(
      <SettingsLayout activeTab="credentials" onTabChange={onTabChange}>
        <div />
      </SettingsLayout>,
    )

    await user.click(screen.getByRole('button', { name: /credentials/i }))
    expect(onTabChange).not.toHaveBeenCalled()
  })

  test('SETTINGS_TABS export lists exactly the four tabs in order', () => {
    // The page above this component reads SETTINGS_TABS for URL-state plumbing,
    // so its shape + order is part of the contract.
    const ids = SETTINGS_TABS.map((t) => t.id)
    expect(ids).toEqual(['credentials', 'endpoints', 'storage', 'app'] satisfies SettingsTabId[])
  })

  test('renders the page heading "Settings"', () => {
    render(
      <SettingsLayout activeTab="credentials" onTabChange={() => {}}>
        <div />
      </SettingsLayout>,
    )
    expect(screen.getByRole('heading', { name: /^settings$/i, level: 1 })).toBeInTheDocument()
  })
})
