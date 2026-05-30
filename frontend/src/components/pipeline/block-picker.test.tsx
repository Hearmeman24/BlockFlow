import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { BlockPicker } from './block-picker'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

const def = (
  type: string,
  label: string,
  opts: { suggestedUpstream?: string[] } = {},
): NodeTypeDef =>
  ({
    type,
    label,
    description: `desc-${label}`,
    size: 'sm',
    inputs: [],
    outputs: [],
    ...opts,
  }) as unknown as NodeTypeDef

describe('BlockPicker', () => {
  it('renders all valid types when open', () => {
    const onSelect = vi.fn()
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[def('a', 'Apple'), def('b', 'Banana')]}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByText('Apple')).toBeTruthy()
    expect(screen.getByText('Banana')).toBeTruthy()
  })

  it('shows the "No blocks can be inserted here" empty state when validTypes is empty', () => {
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[]}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('No blocks can be inserted here')).toBeTruthy()
  })

  it('filters by typed query against label and description', () => {
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[def('a', 'Apple'), def('b', 'Banana')]}
        onSelect={() => {}}
      />,
    )
    const input = screen.getByLabelText('Search blocks') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'ban' } })
    })
    expect(screen.queryByText('Apple')).toBeNull()
    expect(screen.getByText('Banana')).toBeTruthy()
  })

  it('shows "No matches" when filter matches nothing but validTypes is non-empty', () => {
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[def('a', 'Apple')]}
        onSelect={() => {}}
      />,
    )
    const input = screen.getByLabelText('Search blocks') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'zzz' } })
    })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('Enter on the highlighted item invokes onSelect and closes the dialog', () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <BlockPicker
        open
        onOpenChange={onOpenChange}
        validTypes={[def('a', 'Apple'), def('b', 'Banana')]}
        onSelect={onSelect}
      />,
    )
    const input = screen.getByLabelText('Search blocks') as HTMLInputElement
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onSelect).toHaveBeenCalledWith('a') // first item highlighted by default
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Arrow keys move highlight; Enter selects the new one', () => {
    const onSelect = vi.fn()
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[def('a', 'Apple'), def('b', 'Banana')]}
        onSelect={onSelect}
      />,
    )
    const input = screen.getByLabelText('Search blocks') as HTMLInputElement
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    })
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('arrow keys scroll the highlighted item into view', () => {
    const scrollSpy = vi.fn()
    // jsdom does not implement scrollIntoView — install a spy so we can assert
    // the picker called it on the new highlight.
    Element.prototype.scrollIntoView = scrollSpy

    const many = Array.from({ length: 20 }, (_, i) => def(`t${i}`, `Type ${i}`))
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={many}
        onSelect={() => {}}
      />,
    )
    const input = screen.getByLabelText('Search blocks') as HTMLInputElement
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    })
    expect(scrollSpy).toHaveBeenCalled()
  })

  it('suggested types rank first', () => {
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[
          def('a', 'Apple'),
          def('b', 'Banana', { suggestedUpstream: ['source'] }),
        ]}
        upstreamType="source"
        onSelect={() => {}}
      />,
    )
    const items = screen.getAllByRole('option')
    expect(items[0].textContent).toContain('Banana')
    expect(items[1].textContent).toContain('Apple')
  })
})
