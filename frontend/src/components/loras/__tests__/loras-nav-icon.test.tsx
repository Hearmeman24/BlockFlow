/**
 * Nav-icon tests (sgs-ui-eqc.3).
 *
 * - Presets entry renders a clear bundle-catalog label
 * - Models entry replaces the old LoRAs entry while keeping /loras active as an alias
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockPathname = vi.fn<() => string>()
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}))

import { LorasNavIcon } from '../loras-nav-icon'
import { PresetsNavIcon } from '@/components/presets/presets-nav-icon'

beforeEach(() => {
  mockPathname.mockReset()
})

describe('PresetsNavIcon — new text+icon style', () => {
  test('renders the "Presets" label (no longer icon-only)', () => {
    mockPathname.mockReturnValue('/')
    render(<PresetsNavIcon />)
    expect(screen.getByText('Presets')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/presets')
  })

  test('active on /presets', () => {
    mockPathname.mockReturnValue('/presets')
    render(<PresetsNavIcon />)
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page')
  })

  test('active on nested /presets/* path', () => {
    mockPathname.mockReturnValue('/presets/some-id')
    render(<PresetsNavIcon />)
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page')
  })

  test('inactive on /loras', () => {
    mockPathname.mockReturnValue('/loras')
    render(<PresetsNavIcon />)
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-current')
  })
})

describe('LorasNavIcon compatibility wrapper', () => {
  test('renders Models label and links to /models', () => {
    mockPathname.mockReturnValue('/')
    render(<LorasNavIcon />)
    expect(screen.getByText('Models')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/models')
  })

  test('active on /models and compatibility /loras', () => {
    mockPathname.mockReturnValue('/models')
    const { unmount } = render(<LorasNavIcon />)
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page')
    unmount()

    mockPathname.mockReturnValue('/loras')
    render(<LorasNavIcon />)
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page')
  })

  test('inactive on /presets (does not match)', () => {
    mockPathname.mockReturnValue('/presets')
    render(<LorasNavIcon />)
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-current')
  })
})
