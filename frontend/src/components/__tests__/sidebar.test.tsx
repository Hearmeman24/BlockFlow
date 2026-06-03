import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

let mockPathname = '/generate'

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}))

import { Sidebar } from '../sidebar'
import { NAV_ITEMS } from '@/lib/nav-items'

describe('Sidebar', () => {
  test('renders a link for every NAV_ITEMS entry', () => {
    render(<Sidebar />)
    for (const item of NAV_ITEMS) {
      // Sidebar shows icons only; we assert the href is present
      const links = screen.getAllByRole('link')
      const hrefs = links.map((l) => l.getAttribute('href'))
      expect(hrefs).toContain(item.href)
    }
  })

  test('active link matches pathname', () => {
    mockPathname = '/artifacts'
    render(<Sidebar />)
    const links = screen.getAllByRole('link')
    const artifactsLink = links.find((l) => l.getAttribute('href') === '/artifacts')
    expect(artifactsLink?.className).toMatch(/bg-primary/)
  })

  test('NAV_ITEMS count matches sidebar link count', () => {
    render(<Sidebar />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(NAV_ITEMS.length)
  })
})
