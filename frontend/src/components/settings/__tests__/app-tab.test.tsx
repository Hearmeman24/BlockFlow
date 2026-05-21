/**
 * Tests for the <AppTab> (sgs-ui-wisp-las.1 Stage 6).
 *
 * App tab holds the small non-credential preferences:
 *   - BlockFlow version (display-only)
 *   - Default output directory (string app_pref)
 *   - Run history retention (one of 30/90/365/forever — app_pref)
 *   - Links section (docs, GitHub, etc.)
 *
 * Behavior tested:
 *   - Loads existing values on mount
 *   - Persists via setAppPref on change
 *   - Falls back to documented defaults when unset
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getAppPref: vi.fn(),
  setAppPref: vi.fn(),
}))

import * as client from '@/lib/settings/client'
import { AppTab } from '../app-tab'

beforeEach(() => {
  vi.mocked(client.getAppPref).mockReset()
  vi.mocked(client.setAppPref).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppTab', () => {
  test('renders BlockFlow version', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab version="0.2.0" />)
    expect(await screen.findByText(/0\.2\.0/)).toBeInTheDocument()
  })

  test('loads stored output_dir on mount', async () => {
    vi.mocked(client.getAppPref).mockImplementation(async (name) => {
      if (name === 'output_dir') return '/custom/path'
      return null
    })

    render(<AppTab version="x" />)

    expect(await screen.findByDisplayValue('/custom/path')).toBeInTheDocument()
  })

  test('output_dir falls back to "./output" when unset', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab version="x" />)

    expect(await screen.findByDisplayValue('./output')).toBeInTheDocument()
  })

  test('saving output_dir calls setAppPref with the new value', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AppTab version="x" />)

    const input = await screen.findByLabelText(/Default output directory/i)
    await user.clear(input)
    await user.type(input, '/new/out')
    await user.click(screen.getByRole('button', { name: /save output dir/i }))

    await waitFor(() => {
      expect(client.setAppPref).toHaveBeenCalledWith('output_dir', '/new/out')
    })
  })

  test('retention dropdown defaults to 90 days when unset', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab version="x" />)

    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    expect(select.value).toBe('90')
  })

  test('retention dropdown shows the stored value', async () => {
    vi.mocked(client.getAppPref).mockImplementation(async (name) => {
      if (name === 'run_history_retention_days') return '30'
      return null
    })

    render(<AppTab version="x" />)

    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('30'))
  })

  test('changing retention calls setAppPref with the selected value', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AppTab version="x" />)

    const select = await screen.findByLabelText(/Run history retention/i)
    await user.selectOptions(select, '365')

    await waitFor(() => {
      expect(client.setAppPref).toHaveBeenCalledWith('run_history_retention_days', '365')
    })
  })

  test('retention dropdown offers 30 / 90 / 365 / forever options', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab version="x" />)

    const select = await screen.findByLabelText(/Run history retention/i)
    const options = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
    expect(options).toEqual(['30', '90', '365', 'forever'])
  })

  test('"forever" retention persists the literal string "forever"', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AppTab version="x" />)

    const select = await screen.findByLabelText(/Run history retention/i)
    await user.selectOptions(select, 'forever')

    await waitFor(() => {
      expect(client.setAppPref).toHaveBeenCalledWith('run_history_retention_days', 'forever')
    })
  })

  test('renders links section', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab version="x" />)

    expect(await screen.findByRole('link', { name: /GitHub/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /docs/i })).toBeInTheDocument()
  })
})
