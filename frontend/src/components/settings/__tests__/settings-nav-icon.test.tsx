/**
 * Tests for the gear icon in NavBar that links to /settings.
 * Isolated component test so we don't have to mock NavBar's whole dep tree.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock next/navigation hooks used by the icon component.
vi.mock('next/navigation', () => ({
  usePathname: () => '/generate',
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import { SettingsNavIcon } from '../settings-nav-icon'

describe('SettingsNavIcon', () => {
  test('renders a link pointing to /settings', () => {
    render(<SettingsNavIcon />)
    const link = screen.getByRole('link', { name: /settings/i })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/settings')
  })

  test('has accessible title for screen readers + tooltips', () => {
    render(<SettingsNavIcon />)
    const link = screen.getByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('title', 'Settings')
  })
})

describe('SettingsNavIcon — active state', () => {
  test('marks itself active when pathname matches /settings', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({
      usePathname: () => '/settings',
    }))
    const mod = await import('../settings-nav-icon')

    render(<mod.SettingsNavIcon />)
    const link = screen.getByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  test('does not mark itself active on other paths', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({
      usePathname: () => '/generate',
    }))
    const mod = await import('../settings-nav-icon')

    render(<mod.SettingsNavIcon />)
    const link = screen.getByRole('link', { name: /settings/i })
    expect(link).not.toHaveAttribute('aria-current')
  })
})
