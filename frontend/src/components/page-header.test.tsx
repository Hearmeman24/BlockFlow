import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './page-header'

describe('PageHeader', () => {
  it('renders title as an h1', () => {
    render(<PageHeader title="My Page" />)
    expect(screen.getByRole('heading', { level: 1, name: 'My Page' })).toBeInTheDocument()
  })

  it('applies text-2xl font-semibold to the h1', () => {
    render(<PageHeader title="My Page" />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.className).toMatch(/text-2xl/)
    expect(h1.className).toMatch(/font-semibold/)
  })

  it('renders description when provided', () => {
    render(<PageHeader title="My Page" description="A helpful description" />)
    expect(screen.getByText('A helpful description')).toBeInTheDocument()
  })

  it('does not render description element when omitted', () => {
    render(<PageHeader title="My Page" />)
    expect(screen.queryByRole('paragraph')).not.toBeInTheDocument()
  })

  it('description has muted-foreground styling', () => {
    render(<PageHeader title="My Page" description="desc" />)
    const desc = screen.getByText('desc')
    expect(desc.className).toMatch(/text-muted-foreground/)
    expect(desc.className).toMatch(/text-sm/)
  })

  it('renders actions slot content', () => {
    render(<PageHeader title="My Page" actions={<button>Save</button>} />)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('does not render actions container when actions is omitted', () => {
    const { container } = render(<PageHeader title="My Page" />)
    // no right-side div when no actions
    const header = container.querySelector('header')!
    // header should only have the left div, not a second child for actions
    const children = Array.from(header.children)
    expect(children).toHaveLength(1)
  })

  it('forwards className to the header element', () => {
    const { container } = render(<PageHeader title="My Page" className="custom-header" />)
    const header = container.querySelector('header')!
    expect(header.className).toMatch(/custom-header/)
  })
})
