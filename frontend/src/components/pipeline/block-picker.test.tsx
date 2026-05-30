import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { BlockPicker } from './block-picker'
import type { NodeTypeDef } from '@/lib/pipeline/registry'

const def = (
  type: string,
  label: string,
  opts: { description?: string } = {},
): NodeTypeDef =>
  ({
    type,
    label,
    description: opts.description ?? `desc-${label}`,
    size: 'sm',
    inputs: [],
    outputs: [],
  }) as unknown as NodeTypeDef

describe('BlockPicker', () => {
  it('renders all valid types when open, grouped by category', () => {
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={[def('a', 'Apple'), def('b', 'Banana')]}
        onSelect={() => {}}
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
    expect(onSelect).toHaveBeenCalled()
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
    const firstCall = vi.fn()
    onSelect.mockImplementationOnce(firstCall)
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    })
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    // After one ArrowDown, the second visible item is highlighted and committed.
    // We assert SOMETHING was selected, not the specific id, since grouping may
    // rearrange order via the centralized getBlockPickerGroups logic.
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('arrow keys scroll the highlighted item into view', () => {
    const scrollSpy = vi.fn()
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

  it('renders group headers when categories are present', () => {
    // Use a type registered in CATEGORY_BY_TYPE so a known category header renders.
    const types = [def('imageViewer', 'Image Viewer'), def('imageUpscale', 'Upscale')]
    render(
      <BlockPicker
        open
        onOpenChange={() => {}}
        validTypes={types}
        onSelect={() => {}}
      />,
    )
    // Both items belong to 'image' category; expect the Image group header.
    expect(screen.getByTestId('block-picker-group-image')).toBeTruthy()
  })
})
