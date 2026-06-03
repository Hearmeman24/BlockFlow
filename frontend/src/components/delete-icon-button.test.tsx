import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeleteIconButton } from './delete-icon-button'

describe('DeleteIconButton', () => {
  it('renders a button with default aria-label "Delete"', () => {
    render(<DeleteIconButton onClick={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('accepts a custom label via the label prop', () => {
    render(<DeleteIconButton onClick={vi.fn()} label="Remove item" />)
    expect(screen.getByRole('button', { name: 'Remove item' })).toBeInTheDocument()
  })

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn()
    render(<DeleteIconButton onClick={onClick} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('applies hover:text-destructive class', () => {
    render(<DeleteIconButton onClick={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn.className).toMatch(/hover:text-destructive/)
  })

  it('forwards optional className to the button', () => {
    render(<DeleteIconButton onClick={vi.fn()} className="custom-class" />)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn.className).toMatch(/custom-class/)
  })

  it('renders the cross SVG paths', () => {
    const { container } = render(<DeleteIconButton onClick={vi.fn()} />)
    expect(container.querySelector('path')).toBeInTheDocument()
  })
})
