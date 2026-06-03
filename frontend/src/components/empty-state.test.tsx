import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ImageIcon } from 'lucide-react'
import { EmptyState } from './empty-state'

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="No items found" />)
    expect(screen.getByText('No items found')).toBeInTheDocument()
  })

  it('renders the description when provided', () => {
    render(<EmptyState title="No items" description="Try adding one." />)
    expect(screen.getByText('Try adding one.')).toBeInTheDocument()
  })

  it('does not render description when omitted', () => {
    const { container } = render(<EmptyState title="No items" />)
    // Only the title text node should be present (no description p)
    expect(container.querySelectorAll('p')).toHaveLength(1) // just title
  })

  it('renders the action when provided', () => {
    render(<EmptyState title="No items" action={<button>Add item</button>} />)
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument()
  })

  it('renders without action when omitted', () => {
    render(<EmptyState title="No items" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a Lucide icon component when provided', () => {
    const { container } = render(<EmptyState title="No items" icon={ImageIcon} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders a ReactNode icon when provided', () => {
    render(<EmptyState title="No items" icon={<span data-testid="custom-icon" />} />)
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument()
  })

  it('renders without icon when omitted', () => {
    const { container } = render(<EmptyState title="No items" />)
    expect(container.querySelector('svg')).not.toBeInTheDocument()
  })

  it('forwards className to the root element', () => {
    const { container } = render(<EmptyState title="No items" className="my-custom" />)
    expect(container.firstElementChild!.className).toMatch(/my-custom/)
  })

  it('has centered column layout classes', () => {
    const { container } = render(<EmptyState title="No items" />)
    const root = container.firstElementChild!
    expect(root.className).toMatch(/flex/)
    expect(root.className).toMatch(/flex-col/)
    expect(root.className).toMatch(/items-center/)
  })

  it('title uses muted-foreground styling', () => {
    render(<EmptyState title="No items" />)
    const title = screen.getByText('No items')
    expect(title.className).toMatch(/text-muted-foreground/)
  })
})
