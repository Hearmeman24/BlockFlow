import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Select, SelectTrigger, SelectValue } from './select'

describe('SelectTrigger size variants', () => {
  it('renders size="xs" with data-size="xs" attribute', () => {
    const { getByRole } = render(
      <Select>
        <SelectTrigger size="xs">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    )
    const trigger = getByRole('combobox')
    expect(trigger).toHaveAttribute('data-size', 'xs')
  })

  it('size="xs" trigger has the h-7 class applied via data-size selector', () => {
    const { getByRole } = render(
      <Select>
        <SelectTrigger size="xs">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    )
    const trigger = getByRole('combobox')
    // The trigger must carry the data-size=xs attribute so CSS can apply h-7.
    // We verify the attribute is present; JSDOM does not evaluate CSS so we
    // cannot assert the computed height directly.
    expect(trigger.dataset.size).toBe('xs')
  })

  it('size="default" keeps data-size="default"', () => {
    const { getByRole } = render(
      <Select>
        <SelectTrigger size="default">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    )
    expect(getByRole('combobox')).toHaveAttribute('data-size', 'default')
  })

  it('size="sm" keeps data-size="sm"', () => {
    const { getByRole } = render(
      <Select>
        <SelectTrigger size="sm">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    )
    expect(getByRole('combobox')).toHaveAttribute('data-size', 'sm')
  })
})
