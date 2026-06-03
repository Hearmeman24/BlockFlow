import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { BlockField } from '../block-field'

describe('BlockField', () => {
  it('renders the label text', () => {
    render(<BlockField label="My Label"><input /></BlockField>)
    expect(screen.getByText('My Label')).toBeInTheDocument()
  })

  it('renders children inside the field', () => {
    render(
      <BlockField label="Field">
        <input data-testid="child-input" />
      </BlockField>,
    )
    expect(screen.getByTestId('child-input')).toBeInTheDocument()
  })

  it('renders the hint when provided', () => {
    render(
      <BlockField label="Field" hint="This is a hint">
        <input />
      </BlockField>,
    )
    expect(screen.getByText('This is a hint')).toBeInTheDocument()
  })

  it('does not render hint element when hint is not provided', () => {
    render(<BlockField label="Field"><input /></BlockField>)
    expect(screen.queryByRole('paragraph')).toBeNull()
  })

  it('wires htmlFor to the label', () => {
    render(
      <BlockField label="My Label" htmlFor="my-input">
        <input id="my-input" />
      </BlockField>,
    )
    const label = screen.getByText('My Label')
    expect(label).toHaveAttribute('for', 'my-input')
  })

  it('applies extra className to the wrapper', () => {
    const { container } = render(
      <BlockField label="F" className="extra-class">
        <input />
      </BlockField>,
    )
    expect(container.firstChild).toHaveClass('extra-class')
  })
})
