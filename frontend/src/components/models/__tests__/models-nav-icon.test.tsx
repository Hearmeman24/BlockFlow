import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockPathname = vi.fn<() => string>()
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}))

import { LorasNavIcon } from '@/components/loras/loras-nav-icon'

beforeEach(() => {
  mockPathname.mockReset()
})

describe('Models nav entry', () => {
  test('renders Models label and links to /models', () => {
    mockPathname.mockReturnValue('/')
    render(<LorasNavIcon />)
    expect(screen.getByText('Models')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/models')
  })

  test('active on /models and compatibility /loras', () => {
    mockPathname.mockReturnValue('/models')
    const { rerender } = render(<LorasNavIcon />)
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page')

    mockPathname.mockReturnValue('/loras')
    rerender(<LorasNavIcon />)
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page')
  })
})
