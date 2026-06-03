/**
 * Tests for StatusBadge component.
 * Verifies each variant applies the correct semantic token classes and
 * that children render with dense sizing.
 */
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '../status-badge'

describe('StatusBadge', () => {
  describe('success variant', () => {
    test('renders children', () => {
      render(<StatusBadge variant="success">completed</StatusBadge>)
      expect(screen.getByText('completed')).toBeInTheDocument()
    })

    test('applies success token class', () => {
      const { container } = render(<StatusBadge variant="success">ok</StatusBadge>)
      const badge = container.firstElementChild as HTMLElement
      expect(badge.className).toMatch(/bg-success/)
    })

    test('applies dense text size', () => {
      const { container } = render(<StatusBadge variant="success">ok</StatusBadge>)
      const badge = container.firstElementChild as HTMLElement
      // text-2xs (11px) or text-3xs (10px) for dense badge sizing
      expect(badge.className).toMatch(/text-[23]xs/)
    })
  })

  describe('warning variant', () => {
    test('renders children', () => {
      render(<StatusBadge variant="warning">partial</StatusBadge>)
      expect(screen.getByText('partial')).toBeInTheDocument()
    })

    test('applies warning token class', () => {
      const { container } = render(<StatusBadge variant="warning">warn</StatusBadge>)
      const badge = container.firstElementChild as HTMLElement
      expect(badge.className).toMatch(/bg-warning/)
    })
  })

  describe('error variant', () => {
    test('renders children', () => {
      render(<StatusBadge variant="error">failed</StatusBadge>)
      expect(screen.getByText('failed')).toBeInTheDocument()
    })

    test('applies destructive token class', () => {
      const { container } = render(<StatusBadge variant="error">err</StatusBadge>)
      const badge = container.firstElementChild as HTMLElement
      expect(badge.className).toMatch(/bg-destructive/)
    })
  })

  describe('info variant', () => {
    test('renders children', () => {
      render(<StatusBadge variant="info">running</StatusBadge>)
      expect(screen.getByText('running')).toBeInTheDocument()
    })

    test('applies info token class', () => {
      const { container } = render(<StatusBadge variant="info">info</StatusBadge>)
      const badge = container.firstElementChild as HTMLElement
      expect(badge.className).toMatch(/bg-info/)
    })
  })

  describe('neutral variant', () => {
    test('renders children', () => {
      render(<StatusBadge variant="neutral">unknown</StatusBadge>)
      expect(screen.getByText('unknown')).toBeInTheDocument()
    })

    test('applies muted token class', () => {
      const { container } = render(<StatusBadge variant="neutral">n</StatusBadge>)
      const badge = container.firstElementChild as HTMLElement
      expect(badge.className).toMatch(/bg-muted/)
    })
  })

  describe('optional className', () => {
    test('merges extra className', () => {
      const { container } = render(
        <StatusBadge variant="success" className="extra-class">ok</StatusBadge>
      )
      const badge = container.firstElementChild as HTMLElement
      expect(badge.className).toMatch(/extra-class/)
    })
  })
})
