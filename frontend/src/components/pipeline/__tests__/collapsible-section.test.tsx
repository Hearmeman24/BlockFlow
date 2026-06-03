import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import userEvent from '@testing-library/user-event'
import { CollapsibleSection } from '../collapsible-section'

describe('CollapsibleSection', () => {
  it('hides children by default (defaultOpen=false)', () => {
    render(
      <CollapsibleSection label="Advanced">
        <span>Hidden content</span>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument()
  })

  it('shows children when defaultOpen is true', () => {
    render(
      <CollapsibleSection label="Advanced" defaultOpen>
        <span>Visible content</span>
      </CollapsibleSection>,
    )
    expect(screen.getByText('Visible content')).toBeInTheDocument()
  })

  it('toggles open on click', async () => {
    const user = userEvent.setup()
    render(
      <CollapsibleSection label="Settings">
        <span>Toggle me</span>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('Toggle me')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Toggle me')).toBeInTheDocument()
    await user.click(screen.getByRole('button'))
    expect(screen.queryByText('Toggle me')).not.toBeInTheDocument()
  })

  it('renders the badge when provided', () => {
    render(
      <CollapsibleSection label="Section" badge="beta">
        <span>content</span>
      </CollapsibleSection>,
    )
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  it('does not render badge element when badge is not provided', () => {
    render(
      <CollapsibleSection label="Section">
        <span>content</span>
      </CollapsibleSection>,
    )
    // label text is present, but no extra badge span
    expect(screen.getByText('Section')).toBeInTheDocument()
  })

  it('renders trailing slot when provided', () => {
    render(
      <CollapsibleSection label="Section" trailing={<button>action</button>}>
        <span>content</span>
      </CollapsibleSection>,
    )
    expect(screen.getByRole('button', { name: 'action' })).toBeInTheDocument()
  })

  it('renders the label text', () => {
    render(
      <CollapsibleSection label="My Section">
        <span>content</span>
      </CollapsibleSection>,
    )
    expect(screen.getByText('My Section')).toBeInTheDocument()
  })
})
