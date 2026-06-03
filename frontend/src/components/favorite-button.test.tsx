import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FavoriteButton } from './favorite-button'

describe('FavoriteButton', () => {
  it('renders a button with aria-label "Favorite"', () => {
    render(<FavoriteButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Favorite' })).toBeInTheDocument()
  })

  it('has aria-pressed=false when inactive', () => {
    render(<FavoriteButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('has aria-pressed=true when active', () => {
    render(<FavoriteButton active={true} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onToggle when clicked', async () => {
    const onToggle = vi.fn()
    render(<FavoriteButton active={false} onToggle={onToggle} />)
    await userEvent.click(screen.getByRole('button', { name: 'Favorite' }))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('applies non-hover text-warning class when active', () => {
    render(<FavoriteButton active={true} onToggle={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Favorite' })
    // active: text-warning (always on, no hover prefix)
    expect(btn.className).toMatch(/(?<![:\w])text-warning/)
  })

  it('uses only hover:text-warning (not always-on) when inactive', () => {
    render(<FavoriteButton active={false} onToggle={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Favorite' })
    // inactive: amber only on hover — no bare text-warning in className
    expect(btn.className).not.toMatch(/(?<![:\w])text-warning/)
  })

  it('forwards optional className to the button', () => {
    render(<FavoriteButton active={false} onToggle={vi.fn()} className="custom-class" />)
    const btn = screen.getByRole('button', { name: 'Favorite' })
    expect(btn.className).toMatch(/custom-class/)
  })

  it('renders the star SVG polygon', () => {
    const { container } = render(<FavoriteButton active={false} onToggle={vi.fn()} />)
    expect(container.querySelector('polygon')).toBeInTheDocument()
  })

  it('fills the star SVG when active', () => {
    const { container } = render(<FavoriteButton active={true} onToggle={vi.fn()} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('fill')).toBe('currentColor')
  })

  it('does not fill the star SVG when inactive', () => {
    const { container } = render(<FavoriteButton active={false} onToggle={vi.fn()} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('fill')).toBe('none')
  })
})
