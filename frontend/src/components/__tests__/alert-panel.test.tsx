/**
 * Tests for AlertPanel component.
 * Verifies each variant applies the correct semantic token classes and
 * that children, title, and icon props render correctly.
 */
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AlertPanel } from '../alert-panel'

describe('AlertPanel', () => {
  describe('error variant', () => {
    test('renders children', () => {
      render(<AlertPanel variant="error">Something went wrong</AlertPanel>)
      expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    })

    test('applies destructive token classes on wrapper', () => {
      const { container } = render(<AlertPanel variant="error">err</AlertPanel>)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.className).toMatch(/border-destructive/)
      expect(wrapper.className).toMatch(/bg-destructive/)
    })

    test('applies rounded-md and px-3 py-2.5', () => {
      const { container } = render(<AlertPanel variant="error">err</AlertPanel>)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.className).toMatch(/rounded-md/)
      expect(wrapper.className).toMatch(/px-3/)
      expect(wrapper.className).toMatch(/py-2\.5/)
    })
  })

  describe('warning variant', () => {
    test('renders children', () => {
      render(<AlertPanel variant="warning">Watch out</AlertPanel>)
      expect(screen.getByText('Watch out')).toBeInTheDocument()
    })

    test('applies warning token classes on wrapper', () => {
      const { container } = render(<AlertPanel variant="warning">warn</AlertPanel>)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.className).toMatch(/border-warning/)
      expect(wrapper.className).toMatch(/bg-warning/)
    })
  })

  describe('info variant', () => {
    test('renders children', () => {
      render(<AlertPanel variant="info">Just so you know</AlertPanel>)
      expect(screen.getByText('Just so you know')).toBeInTheDocument()
    })

    test('applies info token classes on wrapper', () => {
      const { container } = render(<AlertPanel variant="info">info</AlertPanel>)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.className).toMatch(/border-info/)
      expect(wrapper.className).toMatch(/bg-info/)
    })
  })

  describe('optional props', () => {
    test('renders title when provided', () => {
      render(<AlertPanel variant="error" title="Error title">body</AlertPanel>)
      expect(screen.getByText('Error title')).toBeInTheDocument()
    })

    test('renders icon when provided', () => {
      render(
        <AlertPanel variant="warning" icon={<span data-testid="my-icon" />}>
          body
        </AlertPanel>
      )
      expect(screen.getByTestId('my-icon')).toBeInTheDocument()
    })

    test('merges extra className onto wrapper', () => {
      const { container } = render(
        <AlertPanel variant="info" className="extra-class">info</AlertPanel>
      )
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.className).toMatch(/extra-class/)
    })
  })
})
